// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the owner's PRIVATE PERSONA overlay (ADR-047 §3.5)
//
// SANDBOX_PRIVATE_PERSONA_DIR (default unset) names a directory OUTSIDE both
// repositories holding the owner's own captures. When set, one identity (and
// optionally its NESA results) is overlaid on the synthetic population.
//
// Mechanical guards:
//   • the loader REFUSES any path inside a git work tree (it walks every
//     ancestor of the real path looking for .git);
//   • values live in memory only: never written, never logged (the logger is
//     a field allowlist and labels this persona "PRIVATE"), never in a bundle;
//   • the loader reads JSON files only and recognises them by SHAPE, so it
//     never needs to open any other file in the directory;
//   • it reports what it loaded as booleans, never values.
// ══════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PrivatePersona {
  /** The 16-digit NID the overlay answers for. */
  readonly nid: string;
  /** The captured `data.identityInfo` object, answered verbatim. */
  readonly identityInfo: Readonly<Record<string, unknown>>;
  /** A captured SDMS results record, when the directory holds one. */
  readonly nesa: Readonly<Record<string, unknown>> | null;
}

export class PrivatePersonaRefused extends Error {
  override readonly name = 'PrivatePersonaRefused';
}

/** The innermost git work tree containing `path`, or null. */
export function enclosingGitWorkTree(path: string): string | null {
  let current = realpathSync(path);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Opt-in drill override (SANDBOX_PRIVATE_PERSONA_DISTRICT): move the overlay's
 * home district IN MEMORY to a rehearsal district (the pilot is Nyagatare), so
 * the owner's run is slotted where the drill is staged. Lower administrative
 * levels become synthetic labels. Nothing is written anywhere.
 */
export function withDistrict(persona: PrivatePersona, districtLabel: string, provinceLabel: string): PrivatePersona {
  return {
    ...persona,
    identityInfo: { ...persona.identityInfo, district: districtLabel, province: provinceLabel, sector: 'Synthetic sector (drill)', cell: 'Synthetic cell (drill)', village: 'Synthetic village (drill)', villageId: null },
  };
}

/** Load the overlay, or null when unset. Throws PrivatePersonaRefused on any guard. */
export function loadPrivatePersona(dir: string | undefined): PrivatePersona | null {
  if (dir === undefined || dir.trim() === '') return null;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new PrivatePersonaRefused('SANDBOX_PRIVATE_PERSONA_DIR is not a directory.');
  if (enclosingGitWorkTree(dir) !== null) {
    throw new PrivatePersonaRefused('SANDBOX_PRIVATE_PERSONA_DIR is inside a git work tree. The private persona must live outside every repository.');
  }
  let nid: string | null = null;
  let identityInfo: Record<string, unknown> | null = null;
  let nesa: Record<string, unknown> | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue; // not JSON: ignore without reporting its content
    }
    if (!isRecord(parsed)) continue;
    const data = parsed['data'];
    if (isRecord(data) && isRecord(data['identityInfo'])) {
      const info = data['identityInfo'];
      const profile = isRecord(data['userProfileDto']) ? data['userProfileDto'] : null;
      const fromProfile = typeof profile?.['identificationNumber'] === 'string' ? profile['identificationNumber'] : null;
      const fromDocument = typeof info['documentNumber'] === 'string' ? info['documentNumber'].replace(/\s+/g, '') : null;
      const candidate = fromProfile ?? fromDocument;
      if (candidate !== null && /^\d{16}$/.test(candidate)) {
        nid = candidate;
        identityInfo = info;
      }
    } else if (typeof parsed['studentIndexNumber'] === 'string' && Array.isArray(parsed['rawMark'])) {
      nesa = parsed;
    }
  }
  if (nid === null || identityInfo === null) {
    throw new PrivatePersonaRefused('SANDBOX_PRIVATE_PERSONA_DIR holds no Irembo identity capture (a JSON file with data.identityInfo).');
  }
  return { nid, identityInfo, nesa };
}
