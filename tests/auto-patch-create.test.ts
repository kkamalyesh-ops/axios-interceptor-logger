import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { AxiosLoggerSingleton } from '../src/logger';

async function startServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;
  return { url: `http://localhost:${port}`, close: () => server.close() };
}

test('autoPatchCreate', async (t) => {
  const LOG_PATH = path.join(__dirname, 'auto-patch-create.log');

  t.after(() => {
    if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  });

  await t.test('Should automatically attach to instances created via axios.create() after attach()', async () => {
    const { url, close } = await startServer();

    const logger = AxiosLoggerSingleton.getInstance({ filePath: LOG_PATH });
    // Attaching to the axios module itself (not a single instance) is what
    // triggers the auto-patch of `.create()`.
    logger.attach(axios as any);

    // Created *after* attach() — never passed to logger.attach() directly.
    const derivedClient = axios.create();

    try {
      await derivedClient.get(`${url}/ping`);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(fs.existsSync(LOG_PATH), true, 'Log file should exist');
      const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1, 'The axios.create()-derived instance should have been logged without an explicit attach() call');
    } finally {
      close();
    }
  });
});
