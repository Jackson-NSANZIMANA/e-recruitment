import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxServer } from '../src/server.js';
import { Population } from '../src/population/population.js';
import type { SandboxLog } from '../src/log.js';
import type { PrivatePersona } from '../src/overlay.js';
import type { LiveNesaPassthrough } from '../src/live-nesa.js';
import type { LiveIremboCertificates } from '../src/live-irembo-certificates.js';
import { DEFAULT_PROFILES, type AuthorityProfile } from '../src/behaviour.js';
import type { Authority } from '../src/population/model.js';

const GENEROUS = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([k, v]) => [k, { ...v, bucketCapacity: 10_000 }])) as Record<Authority, AuthorityProfile>;

export const TOKEN = 'test-client-token';
export const REFERENCE = new Date(Date.UTC(2026, 9, 25));

export function population(size = 50): Population {
  return new Population({ seed: 7, size, referenceDate: REFERENCE });
}

export function captureLog(): { log: SandboxLog; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (event, fields) => { lines.push(JSON.stringify({ event, ...(fields ?? {}) })); },
      warn: (event, fields) => { lines.push(JSON.stringify({ event, ...(fields ?? {}) })); },
    },
  };
}

export async function startSandbox(opts: { pop?: Population; overlay?: PrivatePersona | null; overlays?: readonly PrivatePersona[]; live?: LiveNesaPassthrough | null; liveCertificates?: LiveIremboCertificates | null; log?: SandboxLog; timeoutHoldMs?: number; realBudgets?: boolean; host?: string } = {}) {
  const pop = opts.pop ?? population();
  // `overlay` stays the single-subject shorthand; `overlays` is the many-subject world (ADR-047 §3.5).
  const subjects = opts.overlays ?? (opts.overlay == null ? [] : [opts.overlay]);
  const server = await createSandboxServer({
    world: { population: pop, overlay: subjects[0] ?? null, overlays: new Map(subjects.map((s) => [s.nid, s])), live: opts.live ?? null, liveCertificates: opts.liveCertificates ?? null, now: () => new Date(), log: opts.log ?? captureLog().log, clientTokens: new Set([TOKEN]) },
    environment: 'development',
    port: 0,
    host: opts.host ?? '127.0.0.1',
    latencyScale: 0,
    profiles: opts.realBudgets === true ? DEFAULT_PROFILES : GENEROUS,
    timeoutHoldMs: opts.timeoutHoldMs ?? 30,
  });
  return { server, pop };
}

/** A synthetic Irembo identity capture written to a temp directory OUTSIDE any git tree. */
export function syntheticOverlayDir(nid: string, index: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-overlay-test-'));
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ status: true, data: { userProfileDto: { identificationNumber: nid }, identityInfo: { forename: 'Test', surname: 'OVERLAY', sex: 'MALE', dateOfBirth: '01/01/2003', district: 'Gasabo', province: 'Umujyi wa Kigali', nationality: 'RW', citizenStatus: 'NORMAL', documentNumber: nid } } }));
  if (index !== null) writeFileSync(join(dir, 'results.json'), JSON.stringify({ studentIndexNumber: index, studentNames: 'OVERLAY Test', rawMark: [] }));
  writeFileSync(join(dir, 'notes.txt'), 'not json');
  // Every subject the sandbox serves needs a recorded basis (ADR-047 §3.5).
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ subjects: [{ nid, basis: 'synthetic test subject', recordedOn: '2026-01-01' }] }));
  return dir;
}
