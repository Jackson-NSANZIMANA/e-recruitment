import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxServer } from '../src/server.js';
import { Population } from '../src/population/population.js';
import type { SandboxLog } from '../src/log.js';
import type { PrivatePersona } from '../src/overlay.js';
import type { LiveNesaPassthrough } from '../src/live-nesa.js';
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

export async function startSandbox(opts: { pop?: Population; overlay?: PrivatePersona | null; live?: LiveNesaPassthrough | null; log?: SandboxLog; timeoutHoldMs?: number; realBudgets?: boolean } = {}) {
  const pop = opts.pop ?? population();
  const server = await createSandboxServer({
    world: { population: pop, overlay: opts.overlay ?? null, live: opts.live ?? null, now: () => new Date(), log: opts.log ?? captureLog().log, clientTokens: new Set([TOKEN]) },
    environment: 'development',
    port: 0,
    host: '127.0.0.1',
    latencyScale: 0,
    profiles: opts.realBudgets === true ? DEFAULT_PROFILES : GENEROUS,
    timeoutHoldMs: opts.timeoutHoldMs ?? 30,
  });
  return { server, pop };
}

/** A synthetic Irembo identity capture written to a temp directory OUTSIDE any git tree. */
export function syntheticOverlayDir(nid: string, index: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-overlay-test-'));
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ status: true, data: { userProfileDto: { identificationNumber: nid }, identityInfo: { forename: 'Test', surname: 'OVERLAY', sex: 'MALE', dateOfBirth: '01/01/2003', district: 'Gasabo', province: 'Umujyi wa Kigali', nationality: 'RW', citizenStatus: 'NORMAL', documentNumber: '' } } }));
  if (index !== null) writeFileSync(join(dir, 'results.json'), JSON.stringify({ studentIndexNumber: index, studentNames: 'OVERLAY Test', rawMark: [] }));
  writeFileSync(join(dir, 'notes.txt'), 'not json');
  return dir;
}
