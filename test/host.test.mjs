import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native host reports engine status', { timeout: 10_000 }, async () => {
  const hostPath = fileURLToPath(new URL('../src/native-host/host.js', import.meta.url));
  const host = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = Buffer.alloc(0);
  let errors = '';

  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      host.kill();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Host timed out: ${errors}`)), 7000);

    host.stderr.on('data', (chunk) => (errors += chunk));
    host.on('error', (error) => finish(reject, error));
    host.on('exit', (code) => {
      if (!settled) finish(reject, new Error(`Host exited with code ${code}: ${errors}`));
    });
    host.stdout.on('data', (chunk) => {
      output = Buffer.concat([output, chunk]);
      while (output.length >= 4) {
        const length = output.readUInt32LE(0);
        if (output.length < length + 4) return;
        const message = JSON.parse(output.subarray(4, length + 4).toString('utf8'));
        output = output.subarray(length + 4);
        if (message.type === 'pong') finish(resolve, message);
      }
    });

    const payload = Buffer.from(JSON.stringify({ action: 'ping' }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    host.stdin.write(Buffer.concat([header, payload]));
  });

  assert.equal(response.type, 'pong');
  assert.ok(response.ytdlp === null || typeof response.ytdlp === 'string');
  assert.equal(typeof response.ffmpeg, 'boolean');
  assert.equal(typeof response.deno, 'boolean');
});
