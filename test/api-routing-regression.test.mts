/** Routing regression: payment list aliases + frontend API-base URLs. */
import { readFileSync } from 'node:fs';
import { createX402ResourceHandler } from '../src/x402/resourceServer.js';

let pass = 0;
function ok(v, name) { console.log(v ? 'PASS' : 'FAIL', name); if (v) pass++; }
function fakeRes() {
  let status = 0; let body = '';
  return {
    writeHead(s) { status = s; },
    end(b) { body += typeof b === 'string' ? b : ''; },
    get status() { return status; },
    get body() { return body; },
  };
}
function fakeReq(url, method = 'GET') { return { url, method, headers: {} }; }
function portStub(calls) {
  return {
    getPaymentDetail: async (id) => { calls.push(id); return { status: 404, body: {} }; },
    listPayments: async (limit) => { calls.push('list:' + String(limit)); return { status: 200, body: { ok: true, limit: limit ?? null } }; },
  };
}
const calls = [];
const handler = createX402ResourceHandler({ provider: {} as never, resourcePath: '/protected', paymentDetail: portStub(calls) as never });
for (const path of ['/api/payments', '/api/payments/']) {
  const res = fakeRes();
  handler(fakeReq(path), res as never);
  await new Promise((r) => setTimeout(r, 10));
  ok(res.status === 200 && calls.includes('list:undefined'), `payment list route ${path}`);
}
calls.length = 0;
const html = readFileSync(new URL('../web/prototype-v5-6.html', import.meta.url), 'utf8');
ok(html.includes("apiUrl('/prepare')"), 'checkout prepare uses apiUrl');
ok(html.includes("apiUrl('/confirm')"), 'checkout confirm uses apiUrl');
ok(html.includes("apiUrl('/protected')"), 'checkout resource uses apiUrl');
const demo = readFileSync(new URL('../web/demo-wallet.js', import.meta.url), 'utf8');
ok(demo.includes("apiUrl('/prepare')") && demo.includes("apiUrl('/confirm')"), 'wallet adapter uses apiUrl');
const server = readFileSync(new URL('../src/x402/resourceServer.ts', import.meta.url), 'utf8');
ok(server.includes("url === '/api/payments' || url === '/api/payments/'"), 'resource server accepts trailing slash');
const facilitator = readFileSync(new URL('../services/facilitator/src/server.ts', import.meta.url), 'utf8');
ok(facilitator.includes("method === 'POST' && url === '/submit'"), 'facilitator registers /submit');
const walletAdapter = readFileSync(new URL('../web/demo-wallet.js', import.meta.url), 'utf8');
ok(walletAdapter.includes("apiUrl('/submit')"), 'wallet adapter calls /submit');
console.log(`api-routing-regression: ${pass} checks passed`);
process.exit(pass === 9 ? 0 : 1);
