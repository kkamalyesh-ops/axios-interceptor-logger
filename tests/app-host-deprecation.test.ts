import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { AxiosLoggerSingleton } from '../src/logger';

test('APP_HOST deprecated fallback', async (t) => {
  const LOG_PATH = path.join(__dirname, 'app-host-fallback.log');

  t.after(() => {
    if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
    delete process.env.APP_HOST;
  });

  await t.test('Should warn once and still fall back to APP_HOST when sourceDomain is not set', async () => {
    process.env.APP_HOST = 'legacy-host.internal';

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: any) => { warnings.push(String(msg)); };

    let logger: AxiosLoggerSingleton;
    try {
      logger = AxiosLoggerSingleton.getInstance({ filePath: LOG_PATH });
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warnings.some(w => w.includes('APP_HOST') && w.includes('deprecated')),
      `Expected a deprecation warning mentioning APP_HOST, got: ${JSON.stringify(warnings)}`
    );

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const client = axios.create();
    const { eject } = logger.attach(client);

    try {
      await client.get(`http://localhost:${port}/ping`);
      await new Promise(resolve => setTimeout(resolve, 200));

      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const entry = JSON.parse(content.trim().split('\n').filter(Boolean)[0]);
      assert.strictEqual(entry.source.domain, 'legacy-host.internal');
    } finally {
      eject();
      server.close();
    }
  });
});
