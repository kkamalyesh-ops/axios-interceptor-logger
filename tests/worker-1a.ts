import fs from 'fs';
import path from 'path';
import { FileTransport } from '../src/transports/file';

async function run() {
  const GOOD_PATH = path.join(__dirname, 'test-logs.log');
  if (fs.existsSync(GOOD_PATH)) fs.unlinkSync(GOOD_PATH);

  const transport = new FileTransport(GOOD_PATH);
  const originalWarn = console.warn;
  console.warn = () => { };

  try {
    for (let i = 0; i < 100000; i++) {
      transport.log({
        'trace.id': i,
        body: 'x'.repeat(10000)
      } as any);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!fs.existsSync(GOOD_PATH)) throw new Error('File not created');
    const content = fs.readFileSync(GOOD_PATH, 'utf8');
    if (content.trim().split('\n').length === 0) throw new Error('No logs written');
    if ((transport as any).queue.length >= 5000) throw new Error('Queue limit exceeded');

    console.log('SUCCESS');
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    console.warn = originalWarn;
  }
}

run();
