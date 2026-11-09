/**
 * TASK 34.8 — protocol client harness.
 *
 * Sends one v1 request over the Unix socket and prints the JSON reply.
 *
 * Run: npx tsx scripts/task348-client.mts <socket-path> <request-json>
 */

import { createConnection } from 'node:net';

const sock = process.argv[2];
const request = process.argv[3];
if (!sock || !request) {
  console.error('usage: task348-client.mts <socket-path> <request-json>');
  process.exit(2);
}

const conn = createConnection(sock, () => {
  if (process.argv[4] === '--hex') {
    // Raw byte payload (used to test invalid UTF-8 and oversized frames).
    conn.write(Buffer.from(request, 'hex'));
  } else {
    conn.write(request + '\n');
  }
});
let buf = '';
conn.on('data', (c) => {
  buf += c.toString();
  const idx = buf.indexOf('\n');
  if (idx >= 0) {
    process.stdout.write(buf.slice(0, idx));
    conn.end();
  }
});
conn.on('error', (e) => {
  console.error('IPC error:', e.message);
  process.exit(1);
});
