/**
 * IPC caller process.
 *
 * Sends one JSON request over the owner's Unix socket and prints the JSON reply.
 *
 * Run: npx tsx scripts/ipc-caller.mts <socket-path> <request-json>
 */

import { createConnection } from 'node:net';

const sock = process.argv[2];
const request = process.argv[3];
if (!sock || !request) {
  console.error('usage: ipc-caller.mts <socket-path> <request-json>');
  process.exit(2);
}

const conn = createConnection(sock, () => {
  conn.write(request + '\n');
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
