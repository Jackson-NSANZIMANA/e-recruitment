// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — EMPTY MOUNT POINTS that S12b fills (ADR-047 §3.2)
//
//   irembo-certificates  GET  /irembo/rest/public/request/verify-certificate-by-application-number
//   sms-twilio           POST /2010-04-01/Accounts/{sid}/Messages.json
//
// Both answer 501 in their authority's style, so a caller wired early fails
// loudly instead of silently. S12b replaces each with a SimulatorModule.
// ══════════════════════════════════════════════════════════════════

import type { SimResponse, SimulatorModule } from '../module.js';
import { iremboEnvelope } from './irembo-envelope.js';

export const IREMBO_CERTIFICATE_PATH = '/irembo/rest/public/request/verify-certificate-by-application-number';
export const TWILIO_MESSAGES_PATTERN = /^\/2010-04-01\/Accounts\/[A-Za-z0-9]{1,64}\/Messages\.json$/;

export const iremboCertificatesMount: SimulatorModule = {
  id: 'irembo-certificates',
  authority: 'irembo-certificates',
  matches: (method, path) => method === 'GET' && path === IREMBO_CERTIFICATE_PATH,
  authorize: () => ({ client: 'public' }),
  subject: () => null,
  fault: (_kind, world): SimResponse => ({ status: 503, json: iremboEnvelope(world.now(), false, 'SERVICE_UNAVAILABLE', null) }),
  handle: (_req, _subject, world): SimResponse => ({ status: 501, json: iremboEnvelope(world.now(), false, 'NOT_IMPLEMENTED_UNTIL_S12B', null) }),
};

export const smsTwilioMount: SimulatorModule = {
  id: 'sms-twilio',
  authority: 'sms',
  matches: (method, path) => method === 'POST' && TWILIO_MESSAGES_PATTERN.test(path),
  authorize: () => ({ client: 'public' }),
  subject: () => null,
  fault: (): SimResponse => ({ status: 503, json: { code: 20503, message: 'Service unavailable', status: 503 } }),
  handle: (): SimResponse => ({ status: 501, json: { code: 20501, message: 'Not implemented until S12b', status: 501 } }),
};
