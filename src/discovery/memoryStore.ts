/**
 * In-memory Discovery storage — the non-durable `ServiceStore`.
 *
 * This lives in its own module, with no SQLite dependency, on purpose: the
 * MCP server (`src/mcp/server.ts`) loads the registry logic
 * (`src/discovery/registry.ts`) at startup, and the registry's default store
 * is this one. If this function lived in `./store.ts`, every server process
 * would import `node:sqlite` at module load — and on Node 22 that prints an
 * `ExperimentalWarning` to stderr, which the MCP handshake asserts is empty.
 * The SQLite-backed store stays in `./store.ts` and is imported dynamically
 * only when a discovery tool actually needs it.
 */

import type { AuditEntry, ServiceStore } from './store.js';
import type { ServiceRecord } from './registry.js';

export function createMemoryServiceStore(): ServiceStore {
  const services = new Map<string, ServiceRecord>();
  const audit: AuditEntry[] = [];
  return {
    insert(service) {
      if (services.has(service.id)) return { ok: false, reason: 'duplicate_id' };
      services.set(service.id, structuredClone(service));
      return { ok: true };
    },
    update(service) {
      if (!services.has(service.id)) return;
      services.set(service.id, structuredClone(service));
    },
    get(id) {
      const s = services.get(id);
      return s ? structuredClone(s) : undefined;
    },
    listAll() {
      return [...services.values()].map(s => structuredClone(s));
    },
    appendAudit(entry) {
      audit.push({ ...entry });
    },
    auditLog(serviceId) {
      const rows = serviceId ? audit.filter(a => a.serviceId === serviceId) : [...audit];
      return rows.reverse();
    },
    close() {
      /* nothing to close */
    },
  };
}
