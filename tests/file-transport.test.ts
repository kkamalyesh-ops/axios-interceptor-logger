import test from 'node:test';
import assert from 'node:assert';
import { FileTransport } from '../src/transports/file';
import { ConsoleTransport } from '../src/transports/console';
import fs from 'fs';
import path from 'path';

test('FileTransport', async (t) => {
  const BAD_PATH = '/root/forbidden-dir/test.log';
  const GOOD_PATH = path.join(__dirname, 'test-logs.log');

  t.afterEach(() => {
    if (fs.existsSync(GOOD_PATH)) {
      fs.unlinkSync(GOOD_PATH);
    }
  });

  await t.test('Issue #2: Should fallback gracefully to ConsoleTransport when directory creation fails', async () => {
    const transport = new FileTransport(BAD_PATH);

    let consoleErrorCalled = false;
    let consoleErrorMessage = '';
    const originalError = console.error;
    const originalStdout = process.stdout.write;

    console.error = (msg: any) => {
      consoleErrorCalled = true;
      consoleErrorMessage = String(msg);
    };
    (process.stdout.write as any) = () => true;

    try {
      transport.log({ message: 'test' } as any);
      // Let the async fallback trigger
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(consoleErrorCalled, true);
      assert.ok(consoleErrorMessage.includes('Critical failure creating file transport'));
      assert.ok((transport as any).fallbackTransport instanceof ConsoleTransport);
    } finally {
      // Ensure restoration happens even if assertions fail
      console.error = originalError;
      process.stdout.write = originalStdout;
    }
  });

  await t.test('Issue #1a: Should handle backpressure queueing without OOM (Isolated V8 Thread)', async () => {
    // We spawn this in a completely separate Node process to give it a fresh V8 Garbage Collector isolate.
    // This proves that it actually SURVIVES the 100,000 logs and DOES NOT CRASH!
    const { execSync } = require('child_process');
    try {
      const output = execSync('NODE_OPTIONS="--max-old-space-size=64" npx tsx tests/worker-1a.ts', {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      assert.ok(output.includes('SUCCESS'), 'Worker thread should have survived and printed SUCCESS');
    } catch (e: any) {
      assert.fail(`Worker thread unexpectedly crashed! The OOM protection failed: ${e.stdout} ${e.stderr}`);
    }
  });

  await t.test('Issue #1b: Should handle backpressure queueing and limits with event-loop breathing room', async () => {
    // Delete the file created by the previous test manually just in case
    if (fs.existsSync(GOOD_PATH)) fs.unlinkSync(GOOD_PATH);

    const transport = new FileTransport(GOOD_PATH);
    const originalWarn = console.warn;
    console.warn = () => { };

    try {
      // With breathing room. This proves standard asynchronous GC can sweep the logs during an HTTP flood.
      for (let i = 0; i < 20000; i++) {
        transport.log({
          'trace.id': i,
          body: 'x'.repeat(10000)
        } as any);

        if (i % 1000 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // We use await transport.drain() conceptually, but since it's an internal stream, 
      // we just poll the queue length slightly instead of a blind timeout.
      let retries = 10;
      while ((transport as any).queue.length > 0 && retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries--;
      }

      assert.strictEqual(fs.existsSync(GOOD_PATH), true);
      const content = fs.readFileSync(GOOD_PATH, 'utf8');
      const lines = content.trim().split('\n');

      assert.ok(lines.length > 0);
      assert.strictEqual((transport as any).queue.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  await t.test('Issue #1c: Should handle realistic traffic rates seamlessly (e.g. 1000 req/sec)', async () => {
    if (fs.existsSync(GOOD_PATH)) fs.unlinkSync(GOOD_PATH);
    const transport = new FileTransport(GOOD_PATH);

    try {
      // Simulate 1,000 requests spread over 1 second (10 requests every 10ms).
      // This is highly realistic for a production server handling 1k req/sec.
      for (let batch = 0; batch < 100; batch++) {
        for (let i = 0; i < 10; i++) {
          transport.log({
            'trace.id': `req-${batch}-${i}`,
            body: 'normal_sized_payload_data_like_headers_and_status'
          } as any);
        }
        // Realistic network delay / event loop breathing room
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Wait for final disk drain
      let retries = 10;
      while ((transport as any).queue.length > 0 && retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries--;
      }

      assert.strictEqual(fs.existsSync(GOOD_PATH), true);
      const content = fs.readFileSync(GOOD_PATH, 'utf8');

      // Filter out empty lines just in case
      const lines = content.trim().split('\n').filter(Boolean);

      // Because we never flooded the process synchronously, the stream easily kept up.
      // Every single one of the 1,000 logs should have been successfully written!
      assert.strictEqual(lines.length, 1000);
      assert.strictEqual((transport as any).queue.length, 0);
    } finally {
      // no-op
    }
  });

  await t.test('Issue #1d: Should handle varying load and sporadic traffic bursts seamlessly', async () => {
    if (fs.existsSync(GOOD_PATH)) fs.unlinkSync(GOOD_PATH);
    const transport = new FileTransport(GOOD_PATH);

    try {
      // Simulate highly variable, unpredictable traffic patterns
      // 1. Light traffic
      for (let i = 0; i < 50; i++) transport.log({ 'trace.id': `light-${i}`, body: 'x' } as any);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 2. Sudden moderate burst (but below 5000 queue limit so nothing drops)
      for (let i = 0; i < 2000; i++) transport.log({ 'trace.id': `burst1-${i}`, body: 'x'.repeat(100) } as any);
      await new Promise(resolve => setTimeout(resolve, 100)); // breathing room to partially drain

      // 3. Absolute silence
      await new Promise(resolve => setTimeout(resolve, 200));

      // 4. Another burst
      for (let i = 0; i < 1500; i++) transport.log({ 'trace.id': `burst2-${i}`, body: 'x'.repeat(50) } as any);

      // Wait for final disk drain
      let retries = 15;
      while ((transport as any).queue.length > 0 && retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries--;
      }

      assert.strictEqual(fs.existsSync(GOOD_PATH), true);
      const content = fs.readFileSync(GOOD_PATH, 'utf8');

      const lines = content.trim().split('\n').filter(Boolean);

      // Total expected: 50 + 2000 + 1500 = 3550 logs.
      // Because we gave it breathing room, the stream should have easily drained them 
      // all without dropping a single log.
      assert.strictEqual(lines.length, 3550);
      assert.strictEqual((transport as any).queue.length, 0);
    } finally {
      // no-op
    }
  });
});
