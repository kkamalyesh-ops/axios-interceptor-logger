import test from 'node:test';
import assert from 'node:assert';
import { sanitize } from '../src/sanitizer';

test('Sanitizer - Root Cause Serilization Fixes', async (t) => {
  await t.test('Should successfully sanitize BigInt primitives without throwing', () => {
    const payload = {
      id: 12345n,
      nested: {
        value: 9876543210n
      }
    };
    
    const result = sanitize(payload);
    
    // Assert BigInts are converted to strings
    assert.strictEqual(result.id, '12345');
    assert.strictEqual(result.nested.value, '9876543210');
    
    // The ultimate test: native JSON.stringify should not throw!
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  await t.test('Should gracefully handle throwing getters without crashing', () => {
    const payload = {
      normal: 'value',
      get throwing() {
        throw new Error('I crash on read!');
      }
    };
    
    const result = sanitize(payload);
    
    assert.strictEqual(result.normal, 'value');
    assert.strictEqual(result.throwing, '[UNREADABLE_PROPERTY]');
    
    assert.doesNotThrow(() => JSON.stringify(result));
  });
});
