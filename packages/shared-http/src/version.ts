// ══════════════════════════════════════════════════════════════════
// GET /version — build attestation (ADR-038)
//
// Ties a RUNNING process back to the commit it was built from. The image build
// bakes three facts into the environment (services/*/Dockerfile: ARG → ENV):
//
//   USRP_BUILD_SHA   the git commit the image was built from
//   USRP_BUILD_REF   the ref CI built (refs/heads/main, refs/tags/v0.1.0-rc1)
//   USRP_BUILD_TIME  ISO-8601 build instant
//
// and a process may add its own contract / policy fingerprints (the edge
// gateway reports its operation registry and its role → permission map), so a
// dashboard can see version skew between replicas or between the two repos.
//
// The values are read from the environment, so they are VALIDATED, not echoed:
// a mis-set variable must not turn this public, unauthenticated route into a
// reflector for arbitrary text. Anything that does not look like what it
// claims to be is reported as 'unknown'. A process started outside an image
// (pnpm dev, the proofs) has no build facts and says so the same way.
// ══════════════════════════════════════════════════════════════════

import type { VersionInfo } from './types.js';

const UNKNOWN = 'unknown';
const SHA = /^[0-9a-f]{7,40}$/;
const REF = /^[A-Za-z0-9._/-]{1,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FACT_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const FACT_VALUE = /^[A-Za-z0-9._:/@+-]{1,128}$/;

/** What `GET /version` answers. Stable shape; new fields are additive only. */
export interface VersionBody {
  readonly service: string;
  readonly build: { readonly sha: string; readonly ref: string; readonly time: string };
  readonly contract?: Readonly<Record<string, string | number>>;
  readonly policy?: Readonly<Record<string, string | number>>;
}

function pick(value: string | undefined, shape: RegExp): string {
  const trimmed = value?.trim() ?? '';
  return shape.test(trimmed) ? trimmed : UNKNOWN;
}

/** Keep only well-formed fingerprint facts; drop the group if none survive. */
function facts(
  group: Readonly<Record<string, string | number>> | undefined,
): Readonly<Record<string, string | number>> | undefined {
  if (group === undefined) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(group)) {
    if (!FACT_KEY.test(key)) continue;
    if (typeof value === 'number' ? Number.isSafeInteger(value) : FACT_VALUE.test(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** PURE. The `/version` body for a service, from its environment and extras. */
export function versionBody(
  serviceName: string,
  env: Readonly<Record<string, string | undefined>>,
  extras: VersionInfo | undefined,
): VersionBody {
  const contract = facts(extras?.contract);
  const policy = facts(extras?.policy);
  return {
    service: serviceName,
    build: {
      sha: pick(env['USRP_BUILD_SHA'], SHA),
      ref: pick(env['USRP_BUILD_REF'], REF),
      time: pick(env['USRP_BUILD_TIME'], ISO_INSTANT),
    },
    ...(contract === undefined ? {} : { contract }),
    ...(policy === undefined ? {} : { policy }),
  };
}
