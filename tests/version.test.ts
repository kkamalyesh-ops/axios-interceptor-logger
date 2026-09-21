import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { LIB_VERSION } from '../src/version';

test('LIB_VERSION stays in sync with package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(LIB_VERSION, pkg.version);
});
