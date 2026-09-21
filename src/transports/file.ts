import * as fs from 'fs';
import * as path from 'path';
import { LogEntry, LogTransport } from '../types';
import { ConsoleTransport } from './console';

export class FileTransport implements LogTransport {
  private filePath: string;
  private stream: fs.WriteStream | null = null;
  private fallbackTransport: ConsoleTransport | null = null;
  
  private initializing: boolean = false;
  private backpressured: boolean = false;
  
  private queue: string[] = [];
  private queueBytes: number = 0;
  private readonly MAX_QUEUE_BYTES = 20 * 1024 * 1024; // 20 MB memory limit
  
  private lastErrorTime: number = 0;
  private readonly COOLDOWN_MS = 60000; // 60 seconds

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(process.cwd(), 'logs', 'http-transactions.log');
    // Defer file system operations until the first log entry is received to prevent blocking during instantiation.
  }

  private async initStream(): Promise<void> {
    if (this.initializing || this.stream) return;
    
    // Circuit Breaker: Prevent DoS by blocking continuous reinitialization attempts
    if (Date.now() - this.lastErrorTime < this.COOLDOWN_MS) {
      return;
    }

    this.initializing = true;

    try {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });

      this.stream.on('error', (err) => {
        this.handleStreamError(err);
      });

      this.stream.on('drain', () => {
        this.backpressured = false;
        this.flushQueue();
      });

      // Stream successfully created, flush anything that was queued during initialization
      this.flushQueue();
    } catch (err) {
      this.handleStreamError(err);
    } finally {
      this.initializing = false;
    }
  }

  private handleStreamError(err: Error | unknown): void {
    const isFirstFailure = !this.fallbackTransport;
    
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }

    this.lastErrorTime = Date.now();
    
    if (isFirstFailure) {
      this.fallbackTransport = new ConsoleTransport();
      console.error(`[Axios Logger] Critical failure creating file transport at ${this.filePath}. Falling back to console. Error:`, err);
    }
    
    // We are now in a degraded state for at least 60 seconds.
    // Flush the queue to stdout so no logs are lost.
    this.flushQueue();
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;

    if (!this.stream || this.backpressured) {
      if (this.fallbackTransport) {
        // If degraded, flush everything to stdout immediately.
        while (this.queue.length > 0) {
          const item = this.queue.shift();
          if (item) {
            this.queueBytes -= item.length * 2;
            process.stdout.write(item);
          }
        }
      }
      return;
    }

    // Flush to stream
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        this.queueBytes -= item.length * 2;
        const canContinue = this.stream.write(item);
        if (!canContinue) {
          this.backpressured = true;
          break; // Stop flushing and wait for 'drain' event
        }
      }
    }
  }

  log(entry: LogEntry): void {
    // 1. Check Circuit Breaker
    if (!this.stream && this.lastErrorTime > 0) {
       if (Date.now() - this.lastErrorTime > this.COOLDOWN_MS) {
          // Cooldown expired, try to renew stream asynchronously
          this.initStream();
       } else if (this.fallbackTransport) {
          // Still in cooldown, directly use fallback transport
          this.fallbackTransport.log(entry);
          return;
       }
    }

    // 2. Lazy Initialization (only runs once on the very first log)
    if (!this.stream && !this.initializing && this.lastErrorTime === 0) {
      this.initStream(); // Fire and forget promise
    }

    // 3. Serialization
    let logString: string;
    try {
      logString = JSON.stringify(entry) + '\n';
    } catch (e) {
      // Safe fallback if JSON stringification fails (e.g. unexpected circular refs or BigInts)
      logString = JSON.stringify({ error: "Failed to stringify log payload", message: (e as Error).message }) + '\n';
    }

    // 4. Output or Queue
    if (this.stream && !this.backpressured) {
      const canContinue = this.stream.write(logString);
      if (!canContinue) {
        this.backpressured = true;
      }
    } else {
      // Either initializing, backpressured, or circuit breaker tripped
      const stringMemoryBytes = logString.length * 2; // V8 UTF-16 string memory estimation
      const isError = entry.status === 'Error' || !!entry.error;
      const softLimit = this.MAX_QUEUE_BYTES * 0.8; // 80% capacity for INFO logs

      if (this.queueBytes + stringMemoryBytes < (isError ? this.MAX_QUEUE_BYTES : softLimit)) {
        this.queue.push(logString);
        this.queueBytes += stringMemoryBytes;
      } else {
        // Limit reached to prevent OOM
        const now = Date.now();
        if (now - (this as any).lastDropWarningTime > 10000 || !(this as any).lastDropWarningTime) {
           (this as any).lastDropWarningTime = now;
           console.warn(`[Axios Logger] Dropping ${isError ? 'ERROR' : 'INFO'} logs due to disk backpressure. Queue memory limit reached.`);
        }
      }
    }
  }
}
