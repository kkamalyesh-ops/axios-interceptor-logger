import { LogEntry, LogTransport } from '../types';

export class ConsoleTransport implements LogTransport {
  log(entry: LogEntry): void {
    console.log(JSON.stringify(entry, null, 2));
  }
}
