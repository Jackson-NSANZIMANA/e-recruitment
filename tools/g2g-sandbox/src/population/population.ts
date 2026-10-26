// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the synthetic national population (ADR-047 §3.4)
//
// The persona catalogue plus `size` generated citizens, all from one seed.
// Same seed + same reference date ⇒ byte-identical population.
// ══════════════════════════════════════════════════════════════════

import { seededRng, seedOf } from '../prng.js';
import type { SdmsResultsRecord, SyntheticCitizen } from './model.js';
import { PERSONAS } from './personas.js';
import { buildCitizen } from './records.js';

export interface PopulationOptions {
  readonly seed: number;
  /** Generated citizens beyond the catalogue. */
  readonly size: number;
  /** The day ages are measured from (the Kigali calendar date, as UTC midnight). */
  readonly referenceDate: Date;
}

/** First serial of the generated block (catalogue personas use 1–999). */
const GENERATED_SERIAL_BASE = 1000;

export class Population {
  readonly citizens: readonly SyntheticCitizen[];
  private readonly byNid = new Map<string, SyntheticCitizen>();
  private readonly byIndex = new Map<string, SyntheticCitizen>();
  private readonly byPersona = new Map<string, SyntheticCitizen>();

  constructor(readonly options: PopulationOptions) {
    const citizens: SyntheticCitizen[] = [];
    for (const entry of PERSONAS) {
      // Per-persona sub-stream: adding a persona never reshuffles the others.
      // Per-persona stream, INDEPENDENT of the population seed: a persona is
      // the same on every sandbox (proofs and rehearsals rely on it), and
      // adding a persona never reshuffles the others.
      citizens.push(buildCitizen(seededRng(seedOf(`persona:${entry.personaId}`)), entry, options.referenceDate));
    }
    const rng = seededRng(options.seed);
    for (let i = 0; i < options.size; i += 1) {
      const serial = GENERATED_SERIAL_BASE + i;
      citizens.push(
        buildCitizen(
          rng,
          { key: `GEN-${String(i).padStart(5, '0')}`, personaId: null, nidSerial: serial, phoneSerial: serial, identity: {}, nesa: rng.chance(0.8) ? {} : null },
          options.referenceDate,
        ),
      );
    }
    for (const citizen of citizens) {
      if (this.byNid.has(citizen.nid)) throw new Error(`duplicate synthetic NID for ${citizen.key}`);
      this.byNid.set(citizen.nid, citizen);
      if (citizen.nesa !== null) {
        if (this.byIndex.has(citizen.nesa.studentIndexNumber)) throw new Error(`duplicate index number for ${citizen.key}`);
        this.byIndex.set(citizen.nesa.studentIndexNumber, citizen);
      }
      if (citizen.personaId !== null) this.byPersona.set(citizen.personaId, citizen);
    }
    this.citizens = citizens;
  }

  findByNid(nid: string): SyntheticCitizen | null {
    return this.byNid.get(nid) ?? null;
  }

  findByIndex(indexNumber: string): { readonly citizen: SyntheticCitizen; readonly record: SdmsResultsRecord } | null {
    const citizen = this.byIndex.get(indexNumber);
    return citizen?.nesa ? { citizen, record: citizen.nesa } : null;
  }

  persona(personaId: string): SyntheticCitizen {
    const citizen = this.byPersona.get(personaId);
    if (citizen === undefined) throw new Error(`unknown persona ${personaId}`);
    return citizen;
  }
}

/** The Kigali (UTC+2, no DST) calendar date of `now`, as UTC midnight. */
export function kigaliReferenceDate(now: Date): Date {
  const kigali = new Date(now.getTime() + 2 * 3600 * 1000);
  return new Date(Date.UTC(kigali.getUTCFullYear(), kigali.getUTCMonth(), kigali.getUTCDate()));
}
