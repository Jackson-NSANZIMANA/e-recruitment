// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — entry point
//
//   USRP_ENVIRONMENT=sandbox|development (refused in production: fence 1)
//   SANDBOX_PORT (default 4900) · SANDBOX_SEED (default 20261025)
//   SANDBOX_POPULATION_SIZE (default 2000) · SANDBOX_LATENCY_SCALE (default 1)
//   SANDBOX_G2G_CLIENT_TOKENS  comma list; development defaults to the
//                              published dev token, sandbox REQUIRES it
//   SANDBOX_PRIVATE_PERSONA_DIR (optional; outside every git work tree)
//   SANDBOX_NESA_LIVE=1 + SANDBOX_NESA_LIVE_INDEX (optional; sandbox only)
// ══════════════════════════════════════════════════════════════════

import { assertSimulatorAllowed, EnvValidationError } from '@usrp/shared-config';
import { consoleLog } from './log.js';
import { createLiveNesa } from './live-nesa.js';
import { loadPrivatePersona, PrivatePersonaRefused, withDistrict } from './overlay.js';
import { DISTRICT_TO_PROVINCE, type District } from '@usrp/shared-types';
import { districtLabel, PROVINCE_LABEL_RW } from './population/geography.js';
import { kigaliReferenceDate, Population } from './population/population.js';
import { PERSONAS } from './population/personas.js';
import { createSandboxServer } from './server.js';
import { DEV_G2G_CLIENT_TOKEN } from './dev-token.js';


function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new EnvValidationError([`${name} must be a non-negative number.`]);
  return value;
}

async function main(): Promise<void> {
  const log = consoleLog();
  const environment = assertSimulatorAllowed();
  const tokensRaw = process.env['SANDBOX_G2G_CLIENT_TOKENS']?.trim() ?? '';
  if (environment === 'sandbox' && tokensRaw === '') {
    throw new EnvValidationError(['SANDBOX_G2G_CLIENT_TOKENS is required in the sandbox profile (the dev token is development-only).']);
  }
  const clientTokens = new Set((tokensRaw === '' ? DEV_G2G_CLIENT_TOKEN : tokensRaw).split(',').map((t) => t.trim()).filter((t) => t.length > 0));
  if (environment === 'sandbox' && clientTokens.has(DEV_G2G_CLIENT_TOKEN)) {
    throw new EnvValidationError(['SANDBOX_G2G_CLIENT_TOKENS must not contain the published development token in the sandbox profile.']);
  }

  const loaded = loadPrivatePersona(process.env['SANDBOX_PRIVATE_PERSONA_DIR']);
  const drillDistrict = process.env['SANDBOX_PRIVATE_PERSONA_DISTRICT']?.trim().toUpperCase() ?? '';
  let overlay = loaded;
  if (loaded !== null && drillDistrict !== '') {
    if (!Object.hasOwn(DISTRICT_TO_PROVINCE, drillDistrict)) throw new EnvValidationError(['SANDBOX_PRIVATE_PERSONA_DISTRICT must be a district.']);
    const district = drillDistrict as District;
    overlay = withDistrict(loaded, districtLabel(district), PROVINCE_LABEL_RW[DISTRICT_TO_PROVINCE[district]]);
  }
  const liveWanted = process.env['SANDBOX_NESA_LIVE'] === '1';
  const liveIndex = process.env['SANDBOX_NESA_LIVE_INDEX']?.trim() ?? '';
  if (liveWanted && environment !== 'sandbox') throw new EnvValidationError(['SANDBOX_NESA_LIVE is allowed in the sandbox profile only (never in development or CI).']);
  if (liveWanted && !/^[0-9A-Za-z]{8,32}$/.test(liveIndex)) throw new EnvValidationError(['SANDBOX_NESA_LIVE needs exactly one SANDBOX_NESA_LIVE_INDEX.']);
  const live = liveWanted ? createLiveNesa({ index: liveIndex, log }) : null;

  const seed = intEnv('SANDBOX_SEED', 20261025);
  const population = new Population({ seed, size: intEnv('SANDBOX_POPULATION_SIZE', 2000), referenceDate: kigaliReferenceDate(new Date()) });
  const port = intEnv('SANDBOX_PORT', intEnv('PORT', 4900));
  const server = await createSandboxServer({
    world: { population, overlay, live, now: () => new Date(), log, clientTokens },
    environment,
    port,
    latencyScale: intEnv('SANDBOX_LATENCY_SCALE', 1),
    timeoutHoldMs: intEnv('SANDBOX_TIMEOUT_HOLD_MS', 65_000),
  });
  log.info('sandbox_listening', {
    port: server.port, environment, seed, citizens: population.citizens.length, personas: PERSONAS.length,
    overlay: overlay !== null, live: live !== null, modules: 4,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof EnvValidationError || error instanceof PrivatePersonaRefused ? error.message : 'g2g-sandbox failed to start';
  process.stderr.write(`${JSON.stringify({ level: 'error', service: 'g2g-sandbox', event: 'startup_failed', message })}\n`);
  process.exit(1);
});
