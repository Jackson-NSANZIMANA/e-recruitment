// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — entry point
//
//   USRP_ENVIRONMENT=sandbox|development (refused in production: fence 1)
//   SANDBOX_PORT (default 4900) · SANDBOX_SEED (default 20261025)
//   SANDBOX_POPULATION_SIZE (default 2000) · SANDBOX_LATENCY_SCALE (default 1)
//   SANDBOX_G2G_CLIENT_TOKENS  comma list; development defaults to the
//                              published dev token, sandbox REQUIRES it
//   SANDBOX_PRIVATE_PERSONA_DIR (optional; outside every git work tree)
//   SANDBOX_TWILIO_ACCOUNT_SID / SANDBOX_TWILIO_AUTH_TOKEN  the emulator's credentials
//                              (sandbox REQUIRES them; development defaults)
//   SANDBOX_SMS_INBOX_FILE     the emulator's inbox (JSON lines, mode 0600)
//   SANDBOX_NESA_LIVE=1 + SANDBOX_NESA_LIVE_INDEX (optional; sandbox only)
//   SANDBOX_IREMBO_LIVE=1 + SANDBOX_IREMBO_LIVE_NUMBERS (optional; sandbox only) real IremboGov
//                              checks for the listed certificate numbers of consented subjects
// ══════════════════════════════════════════════════════════════════

import { assertSimulatorAllowed, EnvValidationError } from '@usrp/shared-config';
import { consoleLog } from './log.js';
import { createLiveNesa } from './live-nesa.js';
import { createLiveIremboCertificates } from './live-irembo-certificates.js';
import { APPLICATION_NUMBER_PATTERN } from './modules/irembo-certificates.js';
import { loadPrivatePersonas, PrivatePersonaRefused, withDistrict } from './overlay.js';
import { DISTRICT_TO_PROVINCE, type District } from '@usrp/shared-types';
import { districtLabel, PROVINCE_LABEL_RW } from './population/geography.js';
import { kigaliReferenceDate, Population } from './population/population.js';
import { PERSONAS } from './population/personas.js';
import { createSandboxServer } from './server.js';
import { buildModules } from './modules/index.js';
import { DEV_TWILIO_ACCOUNT_SID, DEV_TWILIO_AUTH_TOKEN } from './modules/sms-twilio.js';
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

  const twilioSid = process.env['SANDBOX_TWILIO_ACCOUNT_SID']?.trim() ?? '';
  const twilioToken = process.env['SANDBOX_TWILIO_AUTH_TOKEN']?.trim() ?? '';
  if (environment === 'sandbox' && (twilioSid === '' || twilioToken === '')) {
    throw new EnvValidationError(['SANDBOX_TWILIO_ACCOUNT_SID and SANDBOX_TWILIO_AUTH_TOKEN are required in the sandbox profile (the dev credentials are development-only).']);
  }
  if (environment === 'sandbox' && (twilioSid === DEV_TWILIO_ACCOUNT_SID || twilioToken === DEV_TWILIO_AUTH_TOKEN)) {
    throw new EnvValidationError(['The SMS emulator must not use the published development credentials in the sandbox profile.']);
  }

  // Every consented subject in the directory (ADR-047 §3.5). loadPrivatePersona stays for
  // callers that want the first one; the simulator serves all of them.
  const subjects = loadPrivatePersonas(process.env['SANDBOX_PRIVATE_PERSONA_DIR']);
  const drillDistrict = process.env['SANDBOX_PRIVATE_PERSONA_DISTRICT']?.trim().toUpperCase() ?? '';
  let district: District | null = null;
  if (drillDistrict !== '') {
    if (!Object.hasOwn(DISTRICT_TO_PROVINCE, drillDistrict)) throw new EnvValidationError(['SANDBOX_PRIVATE_PERSONA_DISTRICT must be a district.']);
    district = drillDistrict as District;
  }
  let placed = subjects;
  if (district !== null) {
    const d: District = district;
    placed = subjects.map((s) => withDistrict(s, districtLabel(d), PROVINCE_LABEL_RW[DISTRICT_TO_PROVINCE[d]]));
  }
  const overlays = new Map(placed.map((s) => [s.nid, s]));
  const overlay = placed[0] ?? null;
  const liveWanted = process.env['SANDBOX_NESA_LIVE'] === '1';
  const liveIndex = process.env['SANDBOX_NESA_LIVE_INDEX']?.trim() ?? '';
  if (liveWanted && environment !== 'sandbox') throw new EnvValidationError(['SANDBOX_NESA_LIVE is allowed in the sandbox profile only (never in development or CI).']);
  if (liveWanted && !/^[0-9A-Za-z]{8,32}$/.test(liveIndex)) throw new EnvValidationError(['SANDBOX_NESA_LIVE needs exactly one SANDBOX_NESA_LIVE_INDEX.']);
  const live = liveWanted ? createLiveNesa({ index: liveIndex, log }) : null;
  const iremboLiveWanted = process.env['SANDBOX_IREMBO_LIVE'] === '1';
  if (iremboLiveWanted && environment !== 'sandbox') throw new EnvValidationError(['SANDBOX_IREMBO_LIVE is allowed in the sandbox profile only (never in development or CI).']);
  const liveNumbers = new Set((process.env['SANDBOX_IREMBO_LIVE_NUMBERS'] ?? '').split(',').map((n) => n.trim().toUpperCase()).filter((n) => n !== ''));
  if (iremboLiveWanted && (liveNumbers.size === 0 || [...liveNumbers].some((n) => !APPLICATION_NUMBER_PATTERN.test(n)))) {
    throw new EnvValidationError(['SANDBOX_IREMBO_LIVE needs SANDBOX_IREMBO_LIVE_NUMBERS: comma-separated certificate application numbers (a letter, 12 digits, 4 letters or digits), one per consented subject.']);
  }
  const liveCertificates = iremboLiveWanted ? createLiveIremboCertificates({ numbers: liveNumbers, log }) : null;

  const seed = intEnv('SANDBOX_SEED', 20261025);
  const population = new Population({ seed, size: intEnv('SANDBOX_POPULATION_SIZE', 2000), referenceDate: kigaliReferenceDate(new Date()) });
  const port = intEnv('SANDBOX_PORT', intEnv('PORT', 4900));
  const server = await createSandboxServer({
    world: { population, overlay, overlays, live, liveCertificates, now: () => new Date(), log, clientTokens },
    environment,
    port,
    modules: buildModules({
      ...(twilioSid === '' ? {} : { accountSid: twilioSid }),
      ...(twilioToken === '' ? {} : { authToken: twilioToken }),
      inboxFile: process.env['SANDBOX_SMS_INBOX_FILE'] ?? null,
    }),
    latencyScale: intEnv('SANDBOX_LATENCY_SCALE', 1),
    timeoutHoldMs: intEnv('SANDBOX_TIMEOUT_HOLD_MS', 65_000),
  });
  log.info('sandbox_listening', {
    port: server.port, environment, seed, citizens: population.citizens.length, personas: PERSONAS.length,
    overlay: overlay !== null, subjects: overlays.size, live: live !== null || liveCertificates !== null, modules: 4,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof EnvValidationError || error instanceof PrivatePersonaRefused ? error.message : 'g2g-sandbox failed to start';
  process.stderr.write(`${JSON.stringify({ level: 'error', service: 'g2g-sandbox', event: 'startup_failed', message })}\n`);
  process.exit(1);
});
