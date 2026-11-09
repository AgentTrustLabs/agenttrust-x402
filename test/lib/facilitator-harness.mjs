/**
 * Multi-process facilitator harness for TASK 27.
 *
 * Spawns N real facilitator OS processes, all bound to the same SQLite file, and drives them
 * over HTTP. Submission attempts are counted from a shared append-only ledger written by the
 * instrumented signer inside each process — not from HTTP responses.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SERVER_ENTRY = new URL('../../services/facilitator/dist/server.js', import.meta.url).pathname;

export const SERVER_PATH = SERVER_ENTRY;

export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t27-'));
  return {
    dir,
    db: join(dir, 'facilitator.db'),
    ledger: join(dir, 'submissions.log'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Read the submission ledger, which is appended to by every process. */
export function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return { event: 'unparsable', raw: l };
      }
    });
}

export const submitAttempts = entries => entries.filter(e => e.event === 'submit_attempt').length;

/** A structurally valid, unsigned V1 sponsored transaction fixture. */
export function payloadFixture(over = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const requirements = {
    scheme: 'exact',
    network: CAIP2,
    asset: 'CCD',
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: '3mockSponsorPlaceholderNotARealAccountAddress0000' },
    ...(over.requirements ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: over.resourceUrl ?? 'agenttrust://resource/1004' },
    accepted: { ...requirements, ...(over.accepted ?? {}) },
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER,
          nonce: over.signedOver?.nonce ?? 7,
          expiry: over.expiry ?? nowSec + 200,
          numSignatures: 1,
          sponsor: { address: '3mockSponsorPlaceholderNotARealAccountAddress0000', numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: over.signedOver?.amount ?? '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
}

export const envelope = (p, r) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: r });

/**
 * Start one facilitator process on an ephemeral port and wait until it answers /healthz.
 * Returns the URL and a stop() that resolves when the process has actually exited.
 */
export async function startProcess(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => (stdout += String(d)));
  child.stderr.on('data', d => (stderr += String(d)));

  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not start: ${stderr.slice(0, 300)}`)), 15_000);
    const check = () => {
      const m = /listening on (http:\/\/[^\s]+)/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      } else if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`process exited before listening: ${stderr.slice(0, 300)}`));
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });

  return {
    url,
    pid: child.pid,
    child,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    },
    exited,
    logs: () => ({ stdout, stderr }),
  };
}

/** Start `count` processes sharing one database and one submission ledger. */
export async function startCluster(count, env = {}) {
  const ws = workspace();
  const procs = [];
  for (let i = 0; i < count; i++) {
    procs.push(
      await startProcess({
        FACILITATOR_MODE: 'mock',
        FACILITATOR_HOST: '127.0.0.1',
        FACILITATOR_PORT: '0',
        FACILITATOR_DB_PATH: ws.db,
        FACILITATOR_SUBMIT_LEDGER: ws.ledger,
        FACILITATOR_PROCESS_LABEL: `p${i}`,
        ...env,
      }),
    );
  }
  return {
    ws,
    procs,
    urls: procs.map(p => p.url),
    attempts: () => submitAttempts(readLedger(ws.ledger)),
    ledger: () => readLedger(ws.ledger),
    stopAll: async () => {
      await Promise.all(procs.map(p => p.stop()));
      ws.cleanup();
    },
  };
}

/** POST /settle to one process. Never throws on a non-200; returns the parsed body. */
export async function settle(url, body) {
  const res = await fetch(`${url}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** POST /verify to one process. */
export async function verify(url, body) {
  const res = await fetch(`${url}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

export { CAIP2, PAY_TO, SENDER };
