import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { AxiosLoggerSingleton } from '../src/logger';

test('Axios Integration', async (t) => {
  const LOG_PATH = path.join(__dirname, 'axios-integration.log');
  
  t.beforeEach(() => {
    if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  });

  t.afterEach(() => {
    if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  });

  await t.test('Should successfully intercept and log actual HTTP requests via Axios', async () => {
    // 1. Setup a real HTTP server
    const server = http.createServer((req, res) => {
      // Simulate real-world network latency (10ms)
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', data: 'hello world' }));
      }, 10);
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const url = `http://localhost:${port}`;

    // 2. Setup Axios and Logger
    const client = axios.create();
    const logger = AxiosLoggerSingleton.getInstance({ filePath: LOG_PATH });
    
    // Attach the logger to our specific Axios instance
    const { eject } = logger.attach(client);

    try {
      // 3. Fire actual HTTP requests
      const NUM_REQUESTS = 50;
      const promises = [];
      
      for (let i = 0; i < NUM_REQUESTS; i++) {
        promises.push(
          client.post(`${url}/api/data`, { reqId: i }, {
            headers: { 'X-Custom-Header': 'integration-test' }
          })
        );
      }

      await Promise.all(promises);

      // 4. Wait for the logger stream to flush to disk
      // We need a short delay since stream writing is async
      await new Promise(resolve => setTimeout(resolve, 200));

      // 5. Assertions
      assert.strictEqual(fs.existsSync(LOG_PATH), true, 'Log file should be created');
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);

      assert.strictEqual(lines.length, NUM_REQUESTS, `Should have logged exactly ${NUM_REQUESTS} requests`);
      
      // Parse a log line to verify formatting
      const sampleLog = JSON.parse(lines[0]);
      assert.strictEqual(sampleLog.http.request.method, 'POST');
      assert.strictEqual(sampleLog.url.domain, 'localhost');
      assert.strictEqual(sampleLog.url.port, port);
      assert.strictEqual(sampleLog.http.response.status_code, 200);
      const bodyContent = typeof sampleLog.http.request.body.content === 'string'
        ? JSON.parse(sampleLog.http.request.body.content)
        : sampleLog.http.request.body.content;
      assert.strictEqual(bodyContent.reqId !== undefined, true);

    } finally {
      // 6. Cleanup
      eject();
      server.close();
    }
  });
});
