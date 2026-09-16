export interface LogEntry {
  '@timestamp': string;
  ecs: { version: string };
  agent: {
    name: string;
    type: string;
    version: string;
  };
  event: {
    start: string;
    end: string;
    duration: number; // nanoseconds
    kind: string;
    category: string[];
    type: string[];
    dataset: string;
  };
  http: {
    request: {
      method: string;
      bytes?: number;
      headers?: Record<string, any>;
      body?: { content: any };
    };
    response?: {
      status_code: number;
      bytes?: number;
      headers?: Record<string, any>;
      body?: { content: any };
    };
    version?: string;
  };
  url: {
    full: string;
    path: string;
    query?: string;
    scheme: string;
    domain: string;
    port?: number;
  };
  source?: {
    domain?: string;
  };
  destination?: {
    domain?: string;
  };
  server?: {
    domain?: string;
  };
  network: {
    protocol: string;
  };
  error?: {
    message: string;
    code?: string;
  };
  status: string; // 'OK' | 'Error'
  'trace.id'?: string;
}

export interface LogTransport {
  log(entry: LogEntry): void | Promise<void>;
}

export interface AxiosLoggerConfig {
  ignoreDomains?: string[];
  maxPayloadBytes?: number;
  redactKeys?: string[];
  transportMode?: 'file' | 'otlp' | 'custom';
  filePath?: string;
  otlpEndpoint?: string;
  customLogger?: LogTransport;
  verbose?: boolean;
}
