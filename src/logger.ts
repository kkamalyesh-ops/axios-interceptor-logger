import { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import crypto from 'crypto';
import { AxiosLoggerConfig, LogEntry, LogTransport } from './types';
import { sanitize } from './sanitizer';
import { ConsoleTransport } from './transports/console';
import { FileTransport } from './transports/file';

const TRACKING_SYMBOL = '_axios_logging_metadata' as unknown as symbol; // Cast as symbol to maintain typings below without rewriting everything

interface TrackingMetadata {
  id: string;
  startTime: number;
  logged: boolean;
}

function uuidValidate(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

export class AxiosLoggerSingleton {
  private static instance: AxiosLoggerSingleton;
  private config: AxiosLoggerConfig;
  private transport: LogTransport;

  private constructor(config?: AxiosLoggerConfig) {
    this.config = config || {};
    
    if (this.config.customLogger) {
      this.transport = this.config.customLogger;
    } else if (this.config.transportMode === 'otlp') {
      // Future scope: OTLP Transport
      console.warn('OTLP transport is marked as future scope. Falling back to FileTransport.');
      this.transport = new FileTransport(this.config.filePath);
    } else if (this.config.transportMode === 'file' || !this.config.transportMode) {
      this.transport = new FileTransport(this.config.filePath);
    } else {
      this.transport = new FileTransport(this.config.filePath);
    }
  }

  public static getInstance(config?: AxiosLoggerConfig): AxiosLoggerSingleton {
    if (!AxiosLoggerSingleton.instance) {
      AxiosLoggerSingleton.instance = new AxiosLoggerSingleton(config);
    }
    return AxiosLoggerSingleton.instance;
  }

  public attach(axiosInstance: AxiosInstance): { eject: () => void } {
    const requestInterceptorId = axiosInstance.interceptors.request.use(
      (config) => this.handleRequest(config),
      (error) => Promise.reject(error)
    );

    const responseInterceptorId = axiosInstance.interceptors.response.use(
      (response) => this.handleResponse(response),
      (error) => this.handleError(error)
    );

    return {
      eject: () => {
        axiosInstance.interceptors.request.eject(requestInterceptorId);
        axiosInstance.interceptors.response.eject(responseInterceptorId);
      }
    };
  }

  private isDomainIgnored(reqConfig?: InternalAxiosRequestConfig): boolean {
    if (!reqConfig || !this.config.ignoreDomains) return false;
    
    let fullUrl = reqConfig.url || '';
    if (reqConfig.baseURL && !fullUrl.startsWith('http')) {
      fullUrl = reqConfig.baseURL.replace(/\/+$/, '') + '/' + fullUrl.replace(/^\/+/, '');
    }
    
    try {
      const parsedUrl = new URL(fullUrl, fullUrl.startsWith('/') ? 'http://localhost' : undefined);
      return this.config.ignoreDomains.includes(parsedUrl.hostname);
    } catch (e) {
      return false;
    }
  }

  private handleRequest(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
    if (this.isDomainIgnored(config)) {
      return config;
    }

    let correlationId = config.headers['X-Correlation-ID'] as string;
    
    if (!correlationId || !uuidValidate(correlationId)) {
      correlationId = crypto.randomUUID();
    }
    
    config.headers['X-Correlation-ID'] = correlationId;
    
    (config as any)[TRACKING_SYMBOL] = {
      id: correlationId,
      startTime: Date.now(),
      logged: false
    } as TrackingMetadata;

    return config;
  }

  private handleResponse(response: AxiosResponse): AxiosResponse {
    if (this.isDomainIgnored(response.config as InternalAxiosRequestConfig)) {
      return response;
    }

    this.logTransaction(response.config as InternalAxiosRequestConfig, response, null);
    return response;
  }

  private handleError(error: any): Promise<any> {
    if (error.config && this.isDomainIgnored(error.config)) {
      return Promise.reject(error);
    }

    let config = error.config;
    let metadata: TrackingMetadata | undefined;
    let unlinked = false;

    if (config) {
      metadata = (config as any)[TRACKING_SYMBOL];
    }
    
    if (!metadata) {
      // Fallback strategies to find Correlation-ID
      let correlationId: string | undefined;
      
      if (config && config.headers && config.headers['X-Correlation-ID']) {
        correlationId = config.headers['X-Correlation-ID'] as string;
      } else if (error.response && error.response.config && error.response.config.headers['X-Correlation-ID']) {
        correlationId = error.response.config.headers['X-Correlation-ID'] as string;
      } else if (error.request && typeof error.request.getHeader === 'function') {
        correlationId = error.request.getHeader('X-Correlation-ID');
      }

      if (!correlationId || !uuidValidate(correlationId)) {
        correlationId = crypto.randomUUID();
        unlinked = true;
      }

      metadata = {
        id: correlationId as string,
        startTime: Date.now(), // Estimate
        logged: false
      };
      
      if (config) {
         (config as any)[TRACKING_SYMBOL] = metadata;
      }
    }

    this.logTransaction(config, error.response, error, unlinked);

    return Promise.reject(error);
  }

  private logTransaction(
    config: InternalAxiosRequestConfig | undefined, 
    response: AxiosResponse | undefined, 
    error: any,
    unlinked: boolean = false
  ): void {
    if (!config) {
      return; // Can't log without config (at minimum URL is needed)
    }

    const metadata: TrackingMetadata | undefined = (config as any)[TRACKING_SYMBOL];
    if (!metadata || metadata.logged) {
      return;
    }

    metadata.logged = true;
    const latencyMs = Date.now() - metadata.startTime;

    let fullUrlStr = config.url || '';
    if (config.baseURL && !fullUrlStr.startsWith('http')) {
      fullUrlStr = config.baseURL.replace(/\/+$/, '') + '/' + fullUrlStr.replace(/^\/+/, '');
    }
    
    let parsedUrl: URL | undefined;
    let portNumber: number | undefined;
    try {
      parsedUrl = new URL(fullUrlStr, fullUrlStr.startsWith('/') ? 'http://localhost' : undefined);
      if (parsedUrl.port) {
        portNumber = parseInt(parsedUrl.port, 10);
      }
    } catch (e) { }

    const reqHeaders = config.headers ? sanitize({ ...config.headers }, this.config.redactKeys, this.config.maxPayloadBytes) : {};
    
    let reqBytes: number | undefined;
    if (reqHeaders['content-length']) reqBytes = parseInt(reqHeaders['content-length'] as string, 10);
    else if (config.data && typeof config.data === 'string') reqBytes = Buffer.byteLength(config.data, 'utf8');

    const timestamp = new Date().toISOString();
    const startTimeStr = new Date(metadata.startTime).toISOString();
    const durationNs = latencyMs * 1000000;
    const domain = parsedUrl ? parsedUrl.hostname : 'unknown';

    const entry: LogEntry = {
      '@timestamp': timestamp,
      ecs: { version: '8.0.0' },
      agent: {
        name: 'axios-interceptor-logger',
        type: 'packetbeat',
        version: '1.0.0'
      },
      event: {
        start: startTimeStr,
        end: timestamp,
        duration: durationNs,
        kind: 'event',
        category: ['network'],
        type: ['connection', 'protocol'],
        dataset: 'http'
      },
      http: {
        request: {
          method: (config.method || 'GET').toUpperCase(),
          bytes: reqBytes,
          headers: reqHeaders,
          body: config.data ? { content: sanitize(config.data, this.config.redactKeys, this.config.maxPayloadBytes) } : undefined
        },
        version: '1.1'
      },
      url: {
        full: fullUrlStr,
        path: parsedUrl ? parsedUrl.pathname : fullUrlStr,
        query: parsedUrl && parsedUrl.search ? parsedUrl.search.replace('?', '') : undefined,
        scheme: parsedUrl ? parsedUrl.protocol.replace(':', '') : 'unknown',
        domain: domain,
        port: portNumber
      },
      source: { domain: typeof process !== 'undefined' && process.env && process.env.APP_HOST ? process.env.APP_HOST : 'localhost' },
      destination: { domain },
      server: { domain },
      network: { protocol: 'http' },
      status: error ? 'Error' : 'OK',
      'trace.id': metadata.id
    };

    if (response) {
      const resHeaders = response.headers ? sanitize({ ...response.headers }, this.config.redactKeys, this.config.maxPayloadBytes) : {};
      let resBytes: number | undefined;
      if (resHeaders['content-length']) resBytes = parseInt(resHeaders['content-length'] as string, 10);
      else if (response.data && typeof response.data === 'string') resBytes = Buffer.byteLength(response.data, 'utf8');

      entry.http.response = {
        status_code: response.status,
        headers: resHeaders,
        body: response.data ? { content: sanitize(response.data, this.config.redactKeys, this.config.maxPayloadBytes) } : undefined,
        bytes: resBytes
      };
    }

    if (error) {
      entry.error = {
        message: error.message,
        code: error.code || (error as AxiosError).code
      };
    }

    // Output Pipeline
    if (this.config.verbose) {
      const consoleTransport = new ConsoleTransport();
      consoleTransport.log(entry);
    }

    this.transport.log(entry);
  }
}
