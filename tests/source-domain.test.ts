import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { AxiosLoggerSingleton } from '../src/logger';

test('sourceDomain config', async (t) => {
  const LOG_PATH = path.join(__dirname, 'source-domain.log');

  t.after(() => {
    if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  });

  await t.test('Should populate source.domain from the sourceDomain initializer option', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const client = axios.create();
    const logger = AxiosLoggerSingleton.getInstance({ filePath: LOG_PATH, sourceDomain: 'checkout-service' });
    const { eject } = logger.attach(client);

    try {
      await client.get(`http://localhost:${port}/ping`);
      await new Promise(resolve => setTimeout(resolve, 200));

      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const entry = JSON.parse(content.trim().split('\n').filter(Boolean)[0]);
      assert.strictEqual(entry.source.domain, 'checkout-service');
    } finally {
      eject();
      server.close();
    }
  });
});
