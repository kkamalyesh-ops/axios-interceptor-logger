export function sanitize(
  data: any,
  redactKeys: string[] = ['authorization', 'password', 'token', 'secret', 'cookie'],
  maxPayloadBytes: number = 10240
): any {
  const seen = new WeakSet();

  function sanitizeRecursive(obj: any, currentDepth: number = 0): any {
    if (obj === null || obj === undefined) return obj;
    
    // Primitive types
    if (typeof obj !== 'object' && typeof obj !== 'function') {
      if (typeof obj === 'string') {
        if (Buffer.byteLength(obj, 'utf8') > maxPayloadBytes) {
          return obj.substring(0, maxPayloadBytes / 2) + `... [TRUNCATED ${Buffer.byteLength(obj, 'utf8') - maxPayloadBytes / 2} BYTES]`;
        }
      }
      return obj;
    }

    // Binary / Buffers
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

    if (Array.isArray(obj)) {
      return obj.map((item) => sanitizeRecursive(item, currentDepth + 1));
    }

    const result: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      if (redactKeys.some((rKey) => key.toLowerCase().includes(rKey.toLowerCase()))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeRecursive(obj[key], currentDepth + 1);
      }
    }
    
    seen.delete(obj);
    return result;
  }

  // Handle case where root data exceeds max string representation (rough approximation)
  try {
    const stringified = JSON.stringify(data);
    if (stringified && Buffer.byteLength(stringified, 'utf8') > maxPayloadBytes * 2) {
       // Deeply nested / very large structure overall
       return { '[TRUNCATED_NESTED_DEPTH]': true };
    }
  } catch (e) {
    // Ignore stringify errors (e.g. bigints)
  }

  return sanitizeRecursive(data);
}
