#!/usr/bin/env node
/**
 * agenttrust-discovery — operator CLI for the Discovery service registry.
 *
 * The ONLY write path into the registry. Registration, activation,
 * deactivation and verification are operator actions performed here, on the
 * operator's own machine, against the persistent registry database.
 *
 * Deliberately NOT a server: there is no public POST endpoint and no MCP
 * registration tool. A client that wants a service listed must ask the
 * operator; the operator runs this command.
 *
 *   agenttrust-discovery register --name "Testnet Price Feed" --description "..." \
 *     --category data --endpoint https://api.example.com/price \
 *     --token-id 1004 --owner <base58> --agent-uri https://.../agent-card.json \
 *     --amount 10 --pay-to <base58> [--max-timeout 300] [--price-description "..."] \
 *     [--id svc_price-feed] [--actor alice] [--db /path/discovery.db]
 *   agenttrust-discovery onboard --name "..." --description "..." \
 *     --category data --endpoint https://... --token-id N --owner <base58> \
 *     --agent-uri https://.../agent-card.json --amount 10 --pay-to <base58> \
 *     [--max-timeout 300] [--price-description "..."] [--id svc_...] \
 *     [--timeout-ms 30000] [--actor alice] [--db /path/discovery.db]
 *   agenttrust-discovery list [--status active|inactive|all] [--category data] [--db ...]
 *   agenttrust-discovery show --id svc_... [--db ...]
 *   agenttrust-discovery activate --id svc_... [--db ...]
 *   agenttrust-discovery deactivate --id svc_... [--db ...]
 *   agenttrust-discovery verify --id svc_... [--timeout-ms 30000] [--db ...]
 *   agenttrust-discovery audit [--id svc_...] [--db ...]
 *
 * `onboard` is the controlled onboarding path for a new provider: it
 * validates the submission, registers the service as INACTIVE, verifies
 * the provider identity (CIS-8004 Agent Card via the production
 * verifier), and activates the service ONLY when verification returns
 * TRUSTED. A REJECTED or INCONCLUSIVE outcome leaves the service
 * inactive. Use `onboard` for new providers; `register` + manual
 * `activate` is a lower-level operator path.
 *
 * ACTIVATION POLICY: registration always creates an INACTIVE service.
 * `activate` succeeds ONLY when the provider's verification is TRUSTED;
 * an UNVERIFIED, REJECTED, or INCONCLUSIVE provider is refused, and a
 * service that is somehow active without valid verification is
 * deactivated by the attempt instead of left active. There is no flag,
 * input value, or manual status change that makes a provider active
 * without TRUSTED verification.
 *
 * Output is JSON on stdout (machine-readable); human-readable progress goes
 * to stderr. Exit codes: 0 success · 1 usage, validation, storage, or
 * unknown-service error. `verify` exits 0 whenever a verification result
 * was produced (TRUSTED, REJECTED, or INCONCLUSIVE are all outcomes, not
 * command failures); it exits 1 only when the command itself could not run.
 * `onboard` follows the same rule: it exits 0 when the flow completed
 * (register + a verification attempt ran), even when the provider was not
 * verified and the service stayed inactive — the JSON output reports
 * `activated` and the reason. It exits 1 only on usage, validation,
 * storage, or duplicate-conflict errors.
 *
 * Storage: SQLite (`node:sqlite`, no new dependency) at
 * `$AGENTTRUST_DISCOVERY_DB` or `--db`, default
 * `/home/hatch/agenttrust-state/discovery.db` (durable, survives VM
 * replacement, same directory as the facilitator database).
 *
 * No signing, no settlement, no broadcast, no transactions. No wallet
 * secret is read, displayed, or stored. The CLI only writes service
 * metadata and audit rows.
 */

import { createServiceRegistry, DISCOVERY_NETWORK, type ServiceRegistrationInput } from '../discovery/registry.js';
import { SqliteServiceStore } from '../discovery/store.js';
import { createProductionVerifier } from '../discovery/verify.js';
import { onboardProvider } from '../discovery/onboarding.js';
import { toServiceView } from '../discovery/registry.js';

const DEFAULT_DB = '/home/hatch/agenttrust-state/discovery.db';

function usage(): void {
  console.error(`agenttrust-discovery — operator CLI for the Discovery service registry.

Usage:
  agenttrust-discovery register --name N --description D --category C --endpoint URL
    --token-id N --owner <base58> [--agent-uri URL|null] --amount MICROCCD
    --pay-to <base58> [--max-timeout SEC] [--price-description "..."]
    [--id svc_...] [--actor NAME] [--db PATH]
  agenttrust-discovery onboard --name N --description D --category C --endpoint URL
    --token-id N --owner <base58> --agent-uri URL --amount MICROCCD
    --pay-to <base58> [--max-timeout SEC] [--price-description "..."]
    [--id svc_...] [--timeout-ms MS] [--actor NAME] [--db PATH]
  agenttrust-discovery list [--status active|inactive|all] [--category C] [--db PATH]
  agenttrust-discovery show --id ID [--db PATH]
  agenttrust-discovery activate --id ID [--db PATH]
  agenttrust-discovery deactivate --id ID [--db PATH]
  agenttrust-discovery verify --id ID [--timeout-ms MS] [--db PATH]
  agenttrust-discovery audit [--id ID] [--db PATH]

Network is always Concordium Testnet (${DISCOVERY_NETWORK}).
Categories: data, compute, content, communication, utility, other.
DB: --db, or $AGENTTRUST_DISCOVERY_DB, or ${DEFAULT_DB}.`);
}

type Args = Record<string, string>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[2] ?? '';
  const args: Args = {};
  for (let i = 3; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    args[key] = next !== undefined && !next.startsWith('--') ? next : 'true';
    if (args[key] !== 'true') i++;
  }
  return { cmd, args };
}

function fail(message: string, code = 1): never {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function dbPath(args: Args): string {
  return args['db'] ?? process.env.AGENTTRUST_DISCOVERY_DB ?? DEFAULT_DB;
}

function actor(args: Args): string {
  return args['actor'] ?? process.env.USER ?? 'operator';
}

function openRegistry(args: Args) {
  const path = dbPath(args);
  try {
    const store = new SqliteServiceStore(path);
    return createServiceRegistry(store);
  } catch (e) {
    fail(`cannot open discovery database at ${path}: ${(e as Error).message}`);
  }
}

/** Build a ServiceRegistrationInput from CLI flags. Shared by `register` and `onboard`. */
function buildRegistrationInput(args: Args, cmd: string): ServiceRegistrationInput {
  const required = ['name', 'description', 'category', 'endpoint', 'token-id', 'owner', 'amount', 'pay-to'];
  for (const k of required) {
    if (!args[k]) fail(`${cmd} requires --${k}`);
  }
  const tokenId = Number(args['token-id']);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) fail('--token-id must be a positive integer');
  return {
    ...(args['id'] ? { id: args['id'] } : {}),
    name: args['name']!,
    description: args['description']!,
    category: args['category']!,
    endpoint: args['endpoint']!,
    provider: {
      tokenId,
      ownerAccount: args['owner']!,
      agentUri: args['agent-uri'] === undefined || args['agent-uri'] === 'null' ? null : args['agent-uri']!,
    },
    network: DISCOVERY_NETWORK,
    pricing: {
      amountMicroCcd: args['amount']!,
      asset: 'CCD',
      payTo: args['pay-to']!,
      ...(args['max-timeout'] ? { maxTimeoutSeconds: Number(args['max-timeout']) } : {}),
      ...(args['price-description'] ? { description: args['price-description'] } : {}),
    },
  };
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'register') {
    const input = buildRegistrationInput(args, 'register');
    const registry = openRegistry(args);
    try {
      const result = registry.register(input, { actor: actor(args) });
      if (!result.ok) {
        console.error('registration rejected:');
        for (const e of result.errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      console.error(`registered ${result.service.id} (${result.service.name})`);
      out(toServiceView(result.service));
    } finally {
      registry.close();
    }
    return;
  }

  if (cmd === 'onboard') {
    const input = buildRegistrationInput(args, 'onboard');
    const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      fail('--timeout-ms must be a positive integer');
    }
    const registry = openRegistry(args);
    try {
      console.error(`onboarding provider token ${input.provider.tokenId} (owner ${input.provider.ownerAccount})…`);
      const verifier = createProductionVerifier({ ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      const result = await onboardProvider(registry, input, verifier, { actor: actor(args) });
      if (!result.ok) {
        console.error('onboarding failed:');
        console.error(`  - ${result.reason}`);
        for (const e of result.errors ?? []) console.error(`  - ${e}`);
        process.exit(1);
      }
      console.error(`onboarding: ${result.reason}`);
      out({
        ...toServiceView(result.service!),
        onboarded: result.activated,
        verification: result.verification,
      });
    } finally {
      registry.close();
    }
    return;
  }

  if (cmd === 'list') {
    const registry = openRegistry(args);
    try {
      const { services, total } = registry.list({
        ...(args['category'] ? { category: args['category'] } : {}),
        ...(args['status'] ? { status: args['status'] } : {}),
      });
      out({ services: services.map(toServiceView), total });
    } finally {
      registry.close();
    }
    return;
  }

  if (cmd === 'show') {
    if (!args['id']) fail('show requires --id');
    const registry = openRegistry(args);
    try {
      const service = registry.get(args['id']!);
      if (!service) fail(`service not found: ${args['id']}`);
      out(toServiceView(service));
    } finally {
      registry.close();
    }
    return;
  }

  if (cmd === 'activate' || cmd === 'deactivate') {
    if (!args['id']) fail(`${cmd} requires --id`);
    const status = cmd === 'activate' ? 'active' : 'inactive';
    const registry = openRegistry(args);
    try {
      const result = registry.setStatus(args['id']!, status, { actor: actor(args) });
      if (!result.ok) fail(result.error);
      console.error(`${cmd}d ${result.service.id} → ${status}`);
      out(toServiceView(result.service));
    } finally {
      registry.close();
    }
    return;
  }

  if (cmd === 'verify') {
    if (!args['id']) fail('verify requires --id');
    const registry = openRegistry(args);
    try {
      const service = registry.get(args['id']!);
      if (!service) fail(`service not found: ${args['id']}`);
      const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        fail('--timeout-ms must be a positive integer');
      }
      console.error(`verifying provider token ${service.provider.tokenId} (owner ${service.provider.ownerAccount})…`);
      const verifier = createProductionVerifier({ ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      const result = await registry.verifyProvider(args['id']!, verifier, { actor: actor(args) });
      if (!result.ok) fail(result.error);
      const v = result.service.providerVerification;
      console.error(`verification: ${v.status} (${v.decision ?? 'no decision'}) — ${v.reason ?? ''}`);
      out(toServiceView(result.service));
    } finally {
      registry.close();
    }
    return;
  }

  if (cmd === 'audit') {
    const registry = openRegistry(args);
    try {
      const entries = registry.auditLog(args['id']);
      out({ entries, total: entries.length });
    } finally {
      registry.close();
    }
    return;
  }

  usage();
  fail(`unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error('ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
