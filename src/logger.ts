import { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import crypto from 'crypto';
import { AxiosLoggerConfig, LogEntry, LogTransport } from './types';
import { sanitize } from './sanitizer';
import { ConsoleTransport } from './transports/console';
import { FileTransport } from './transports/file';
import { LIB_VERSION } from './version';

// A real Symbol so this metadata never shows up in Object.keys/JSON.stringify
// of the caller's axios config — a plain string key would leak into any code
// that inspects or logs that config elsewhere.
const TRACKING_SYMBOL = Symbol('axios_logging_metadata');

// Tracks which axios modules/instances already had their `.create()` wrapped,
// so attach() stays idempotent if called again on the same object (e.g. a
// singleton re-attaching, or a created instance whose own `.create()` is
// patched on the way in).
const PATCHED_CREATE = new WeakSet<object>();

interface TrackingMetadata {
  id: string;
  startTime: number;
  logged: boolean;
}

function uuidValidate(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

function assertNodeEnvironment(): void {
  const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
  if (!isNode) {
    throw new Error(
      '[axios-interceptor-logger] This library uses Node.js core modules (fs, crypto) and is not supported outside a Node.js runtime (e.g. browser bundles).'
    );
  }
}

export class AxiosLoggerSingleton {
  private static instance: AxiosLoggerSingleton;
  private config: AxiosLoggerConfig;
  private transport: LogTransport;

  private constructor(config?: AxiosLoggerConfig) {
    assertNodeEnvironment();
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

    if (!this.config.sourceDomain && typeof process !== 'undefined' && process.env && process.env.APP_HOST) {
      console.warn(
        '[axios-interceptor-logger] The APP_HOST environment variable is deprecated and will be removed in a future release. Pass `sourceDomain` to AxiosLoggerSingleton.getInstance() instead.'
      );
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

    if (this.config.autoPatchCreate !== false) {
      this.patchCreateIfPresent(axiosInstance);
    }

    return {
      eject: () => {
        axiosInstance.interceptors.request.eject(requestInterceptorId);
        axiosInstance.interceptors.response.eject(responseInterceptorId);
      }
    };
  }

  // axios.create()'d instances get their own independent interceptor stack —
  // attach() only ever sees the exact instance it was handed. When that
  // instance also exposes `.create()` (the top-level `axios` default export,
  // or any instance produced by it), wrap `.create()` so every instance it
  // produces from here on is attach()'d automatically, with no per-call-site
  // wiring required from the consumer.
  private patchCreateIfPresent(target: unknown): void {
    const candidate = target as { create?: (config?: any) => AxiosInstance };
    if (typeof candidate.create !== 'function' || PATCHED_CREATE.has(candidate as object)) {
      return;
    }

    PATCHED_CREATE.add(candidate as object);
    const originalCreate = candidate.create.bind(candidate);
    candidate.create = ((config?: any) => {
      const instance = originalCreate(config);
      this.attach(instance);
      return instance;
    }) as typeof candidate.create;
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

    setImmediate(() => this.logTransaction(response.config as InternalAxiosRequestConfig, response, null));
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

    setImmediate(() => this.logTransaction(config, error.response, error, unlinked));

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
    const sourceDomain =
      this.config.sourceDomain ||
      (typeof process !== 'undefined' && process.env && process.env.APP_HOST) ||
      'localhost';

    const entry: LogEntry = {
      '@timestamp': timestamp,
      ecs: { version: '8.0.0' },
      agent: {
        name: 'axios-interceptor-logger',
        type: 'axios-logger',
        version: LIB_VERSION
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
      source: { domain: sourceDomain },
      destination: { domain },
      server: { domain },
      network: { protocol: 'http' },
      status: error ? 'Error' : 'OK',
      'trace.id': metadata.id
    };

    if (response) {
      const resHeaders = response.headers ? sanitize({ ...response.headers }, this.config.redactKeys, this.config.maxPayloadBytes) : {};
      let resBytes: number | undefined;
      // TODO: fallback for chunked responses (no content-length) — compute from JSON.stringify(response.data) for object bodies
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
        message: error.message ? String(error.message) : 'Unknown error',
        code: error.code || (error as AxiosError).code ? String(error.code || (error as AxiosError).code) : undefined
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
