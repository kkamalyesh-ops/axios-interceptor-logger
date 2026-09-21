const MAX_DEPTH = 10;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 100;
const DEFAULT_MAX_PAYLOAD_BYTES = 10240;
// Absolute ceiling on per-string truncation regardless of what a caller passes in,
// so a misconfigured maxPayloadBytes can't reopen the size/perf issues this cap fixed.
const HARD_MAX_STRING_CHARS = 10000;

export const DEFAULT_REDACT_KEYS = [
  'authorization',
  'password',
  'token',
  'secret',
  'cookie',
  'apikey',
  'api_key',
  'api-key',
  'privatekey',
  'private_key',
  'private-key'
];

export function sanitize(
  data: any,
  redactKeys: string[] = DEFAULT_REDACT_KEYS,
  maxPayloadBytes: number = DEFAULT_MAX_PAYLOAD_BYTES
): any {
  // maxPayloadBytes bounds the per-string truncation length (in characters, a close
  // approximation of bytes for typical payloads) — clamped so callers can't disable
  // the safety ceiling that keeps sanitization bounded on pathological input.
  const maxStringChars = Math.min(Math.max(0, maxPayloadBytes || 0), HARD_MAX_STRING_CHARS);
  const seen = new WeakSet();

  function sanitizeRecursive(obj: any, currentDepth: number = 0): any {
    if (obj === null || obj === undefined) return obj;

    if (currentDepth >= MAX_DEPTH) {
      return '[MAX_DEPTH_EXCEEDED]';
    }

    // Primitive types
    if (typeof obj !== 'object' && typeof obj !== 'function') {
      if (typeof obj === 'string') {
        if (obj.length > maxStringChars) {
          return obj.substring(0, maxStringChars) + `... [TRUNCATED ${obj.length - maxStringChars} CHARACTERS]`;
        }
        return obj;
      }
      if (typeof obj === 'bigint') {
        return obj.toString();
      }
      return obj;
    }

    // Binary / Buffers — summarise without touching the bytes
    if (Buffer.isBuffer(obj) || obj instanceof ArrayBuffer || (typeof Blob !== 'undefined' && obj instanceof Blob)) {
      const type = Buffer.isBuffer(obj) ? 'Buffer' : (obj instanceof ArrayBuffer ? 'ArrayBuffer' : 'Blob');
      const size = (obj as any).byteLength || (obj as any).size || 0;
      return { '[BINARY_DATA]': `<Type: ${type}, Size: ${size} bytes>` };
    }

    // Circular reference check
    if (seen.has(obj)) {
      return '[CIRCULAR_REFERENCE]';
    }
    seen.add(obj);

    let result: any;
    if (Array.isArray(obj)) {
      const truncated = obj.length > MAX_ARRAY_ITEMS;
      result = obj.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeRecursive(item, currentDepth + 1));
      if (truncated) result.push(`[... ${obj.length - MAX_ARRAY_ITEMS} MORE ITEMS TRUNCATED]`);
    } else {
      result = {} as Record<string, any>;
      const keys = Object.keys(obj);
      const truncated = keys.length > MAX_KEYS;
      for (const key of keys.slice(0, MAX_KEYS)) {
        if (redactKeys.some((rKey) => key.toLowerCase().includes(rKey.toLowerCase()))) {
          result[key] = '[REDACTED]';
        } else {
          try {
            result[key] = sanitizeRecursive(obj[key], currentDepth + 1);
          } catch (e) {
            result[key] = '[UNREADABLE_PROPERTY]';
          }
        }
      }
      if (truncated) result['[TRUNCATED_KEYS]'] = `${keys.length - MAX_KEYS} more keys omitted`;
    }

    seen.delete(obj);
    return result;
  }

  return sanitizeRecursive(data);
}
