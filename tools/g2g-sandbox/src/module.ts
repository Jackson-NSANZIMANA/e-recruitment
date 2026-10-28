// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — THE SIMULATOR MODULE INTERFACE (hand-off to S12b)
//
// One server mounts every simulator. A module owns one authority's wire
// format; the server owns everything around it, identically for all modules:
//
//   match → authorize → token bucket (429) → behaviour (latency, faults) → handle
//
// so a module never re-implements rate limiting, latency, maintenance windows,
// truncation, timeouts or the x-usrp-sandbox stamp. To add a simulator
// (S12b: irembo-certificates, sms-twilio):
//   1. implement SimulatorModule in src/modules/<id>.ts;
//   2. answer the production paths and envelopes byte for byte, from a
//      captured shape under contracts/ (values stripped), with a test that
//      validates every response against it;
//   3. put it in MODULES (src/modules/index.ts), replacing the empty mount.
// ══════════════════════════════════════════════════════════════════

import type { Population } from './population/population.js';
import type { Authority, BehaviourName, SdmsResultsRecord, SyntheticCitizen } from './population/model.js';
import type { PrivatePersona } from './overlay.js';
import type { LiveNesaPassthrough } from './live-nesa.js';
import type { SandboxLog } from './log.js';

export type SimulatorId = 'nida-irembo' | 'nesa-sdms' | 'irembo-certificates' | 'sms-twilio';

export interface SimRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** Case-insensitive single header value, or null. */
  header(name: string): string | null;
  /** Raw body bytes (bounded by the server). */
  body(): Promise<Buffer>;
}

export interface SimResponse {
  readonly status: number;
  /** JSON body (serialised by the server)... */
  readonly json?: unknown;
  /** ...or verbatim text (form-encoded, XML, a deliberately broken body). */
  readonly raw?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Who the request is about: a synthetic citizen, or the private overlay persona. */
export type Subject =
  | { readonly kind: 'synthetic'; readonly citizen: SyntheticCitizen }
  | { readonly kind: 'private'; readonly persona: PrivatePersona };

/** Everything a module may read. Values from `overlay` must never be logged. */
export interface SandboxWorld {
  readonly population: Population;
  readonly overlay: PrivatePersona | null;
  readonly live: LiveNesaPassthrough | null;
  readonly now: () => Date;
  readonly log: SandboxLog;
  /** G2G client tokens accepted by authenticated simulators. */
  readonly clientTokens: ReadonlySet<string>;
}

export type FaultKind = 'rate-limited' | 'maintenance' | 'status-false';

export interface SimulatorModule {
  readonly id: SimulatorId;
  readonly authority: Authority;
  matches(method: string, path: string): boolean;
  /**
   * Authenticate. Returns the client key for the token bucket, or the refusal
   * to send. Public endpoints return a constant key.
   */
  authorize(req: SimRequest, world: SandboxWorld): { readonly client: string } | SimResponse;
  /** Resolve who the request is about (drives persona behaviour); null if nobody. */
  subject(req: SimRequest, world: SandboxWorld): Subject | null;
  /** The authority's own envelope for a fault, in its wire style. */
  fault(kind: FaultKind, world: SandboxWorld): SimResponse;
  handle(req: SimRequest, subject: Subject | null, world: SandboxWorld): Promise<SimResponse> | SimResponse;
}

/** Persona id for logs: catalogue id, generated key, or "PRIVATE" (never a value). */
export function subjectLabel(subject: Subject | null): string {
  if (subject === null) return 'none';
  return subject.kind === 'private' ? 'PRIVATE' : subject.citizen.key;
}

export function personaBehaviour(subject: Subject | null, authority: Authority): BehaviourName | null {
  if (subject?.kind !== 'synthetic') return null;
  return subject.citizen.behaviour[authority] ?? null;
}

export type { SdmsResultsRecord };
