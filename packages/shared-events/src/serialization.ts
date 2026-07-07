// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Serialization
//
// ADR-001 addendum: the target is Avro + Schema Registry. As an interim
// (to keep services moving) we ship a versioned JSON serializer behind
// this Serializer interface. Swapping to Avro later means adding an
// AvroEventSerializer and changing one wiring line — producers and
// consumers depend only on the interface.
// ══════════════════════════════════════════════════════════════════

import type { USRPEvent } from '@usrp/shared-types';
import { hasValidEnvelope } from './envelope.js';

export class EventDeserializationError extends Error {
  constructor(message: string) {
    super(`Failed to deserialize event: ${message}`);
    this.name = 'EventDeserializationError';
  }
}

export interface EventSerializer {
  serialize(event: USRPEvent): Buffer;
  deserialize(data: Buffer): USRPEvent;
}

/** JSON serializer with structural envelope validation on the way in. */
export class JsonEventSerializer implements EventSerializer {
  serialize(event: USRPEvent): Buffer {
    return Buffer.from(JSON.stringify(event), 'utf8');
  }

  deserialize(data: Buffer): USRPEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      throw new EventDeserializationError('payload is not valid JSON');
    }
    if (!hasValidEnvelope(parsed)) {
      throw new EventDeserializationError('missing or invalid event envelope');
    }
    return parsed as USRPEvent;
  }
}
