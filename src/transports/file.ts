import * as fs from 'fs';
import * as path from 'path';
import { LogEntry, LogTransport } from '../types';

export class FileTransport implements LogTransport {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(process.cwd(), 'logs', 'http-transactions.log');
    this.ensureDirectoryExists(this.filePath);
  }

  private ensureDirectoryExists(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  log(entry: LogEntry): void {
    const logString = JSON.stringify(entry) + '\n';
    
    // Non-blocking asynchronous append
    fs.appendFile(this.filePath, logString, (err) => {
      if (err) {
        // Fallback to console if file write fails to avoid losing the log entirely
        console.error(`Failed to write to log file: ${this.filePath}`, err);
      }
    });
  }
}
