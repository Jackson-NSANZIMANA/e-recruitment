// ══════════════════════════════════════════════════════════════════
// edge-gateway — Browser channel → platform channel
//
// A REAL DIVERGENCE, TRANSLATED IN EXACTLY ONE PLACE.
//
// The frontend registry offers `WEB | USSD | FIELD`. The platform's channel
// vocabulary (shared-types APPLICATION_CHANNELS, and the
// public_core.application_channel enum behind it) is
// `WEB | USSD | IREMBO_KIOSK | WALK_IN`. There is no FIELD.
//
// Sending FIELD upstream is a 400 INVALID_CHANNEL every time — so the edge maps
// it onto WALK_IN, which is what "field" means in this domain: a candidate
// registered by an officer at a venue. Mapping here rather than "fixing" the
// frontend enum is the right call for one reason: the browser vocabulary is a
// UI concept and the enum is a database type, and the edge exists to translate
// between the two. Recorded in docs/CONTRACT-DEVIATIONS.md so it is a decision
// rather than a surprise.
//
// IREMBO_KIOSK is deliberately NOT reachable from a browser: a kiosk is a
// different physical trust context and claiming it from a web session is an
// unverifiable assertion about where the person is standing.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationChannel } from '@usrp/shared-types';

/** The channel names a browser may send. */
export const BROWSER_CHANNELS: readonly string[] = ['WEB', 'USSD', 'FIELD'];

export function toPlatformChannel(value: unknown): ApplicationChannel | null {
  if (value === undefined || value === null) return 'WEB';
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'WEB':
      return 'WEB';
    case 'USSD':
      return 'USSD';
    case 'FIELD':
      return 'WALK_IN';
    default:
      return null;
  }
}
