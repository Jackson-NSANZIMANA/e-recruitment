// ══════════════════════════════════════════════════════════════════
// biometric-service — ReferenceSource adapters (ADR-037 §2)
//
// CARD_PORTRAIT is device-attested. NIDA_PORTRAIT is NOT AUTHORISED and has no
// switch: opening it is a code change behind a new ADR (G2G authorisation and
// a lawful basis), never an environment flag someone can flip at a venue.
// ══════════════════════════════════════════════════════════════════

import type { ReferenceSourceId } from '../domain/evidence-record.js';
import type { ReferenceSource, ReferenceSourceRegistry } from '../ports/reference-source.js';

const CARD_PORTRAIT: ReferenceSource = Object.freeze({ id: 'CARD_PORTRAIT', status: 'DEVICE_ATTESTED' });
const NIDA_PORTRAIT: ReferenceSource = Object.freeze({ id: 'NIDA_PORTRAIT', status: 'NOT_AUTHORISED' });
const NONE: ReferenceSource = Object.freeze({ id: 'NONE', status: 'MANUAL_ONLY' });

export class FixedReferenceSources implements ReferenceSourceRegistry {
  source(id: ReferenceSourceId): ReferenceSource {
    switch (id) {
      case 'CARD_PORTRAIT':
        return CARD_PORTRAIT;
      case 'NIDA_PORTRAIT':
        return NIDA_PORTRAIT;
      case 'NONE':
        return NONE;
    }
  }

  all(): readonly ReferenceSource[] {
    return [CARD_PORTRAIT, NIDA_PORTRAIT, NONE];
  }
}
