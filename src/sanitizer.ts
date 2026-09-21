const MAX_DEPTH = 10;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_CHARS = 1000;

export function sanitize(
  data: any,
  redactKeys: string[] = ['authorization', 'password', 'token', 'secret', 'cookie'],
  _maxPayloadBytes: number = 10240
): any {
  const seen = new WeakSet();

  function sanitizeRecursive(obj: any, currentDepth: number = 0): any {
    if (obj === null || obj === undefined) return obj;

    if (currentDepth >= MAX_DEPTH) {
      return '[MAX_DEPTH_EXCEEDED]';
    }

    // Primitive types
    if (typeof obj !== 'object' && typeof obj !== 'function') {
      if (typeof obj === 'string') {
        if (obj.length > MAX_STRING_CHARS) {
          return obj.substring(0, MAX_STRING_CHARS) + `... [TRUNCATED ${obj.length - MAX_STRING_CHARS} CHARACTERS]`;
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
