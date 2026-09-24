import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { AxiosLoggerSingleton } from '../src/logger';

test('autoPatchCreate: false', async (t) => {
  const LOG_PATH = path.join(__dirname, 'auto-patch-create-disabled.log');

  t.after(() => {
    if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  });

  await t.test('Should NOT patch axios.create() when autoPatchCreate is false', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const logger = AxiosLoggerSingleton.getInstance({ filePath: LOG_PATH, autoPatchCreate: false });
    logger.attach(axios as any);

    // Created after attach() with auto-patch disabled — should NOT be logged
    // since it was never explicitly passed to logger.attach().
    const derivedClient = axios.create();

    try {
      await derivedClient.get(`http://localhost:${port}/ping`);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(fs.existsSync(LOG_PATH), false, 'No log entry should have been written for an unattached instance');
    } finally {
      server.close();
    }
  });
});
