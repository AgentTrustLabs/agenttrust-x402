// Gateway↔facilitator compatibility against a LIVE mock facilitator process.
// Proves the gateway's own probe/classifier accept the isolated service's /supported.
import { probeFacilitator, classifyCompatibility } from '../src/payments/facilitator.js';
import { createHttpFacilitator } from '../src/payments/x402Sdk.js';
import { startFacilitator } from '../services/facilitator/src/server.js';

const started = await startFacilitator({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_PORT: '0',
  FACILITATOR_HOST: '127.0.0.1',
});
console.log('facilitator url:', started.url);

try {
  const probe = await probeFacilitator({ url: started.url });
  console.log('probeFacilitator:', JSON.stringify({ ok: probe.ok, status: probe.status, kind: probe.ok ? 'none' : probe.kind }));
  if (!probe.ok) {
    console.error('FAIL: gateway probe rejected the service');
    process.exit(1);
  }

  const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
  const compat = classifyCompatibility(probe.body, CAIP2);
  console.log(
    'classifyCompatibility:',
    JSON.stringify({ usable: compat.usable, code: compat.code, feePayer: compat.feePayer, schemes: compat.schemesOnNetwork }),
  );

  const f = createHttpFacilitator({ url: started.url });
  const sup = await f.getSupported();
  console.log('createHttpFacilitator.getSupported:', sup.kinds.length, 'kind(s),', JSON.stringify(sup.kinds.map(k => k.network)));

  const ok = probe.ok && compat.usable === true && compat.code === 'OK' && sup.kinds.length === 1;
  console.log(`\nVERDICT: ${ok ? 'gateway ACCEPTS the isolated facilitator unmodified' : 'MISMATCH'}`);
  process.exit(ok ? 0 : 1);
} finally {
  await started.close();
}
