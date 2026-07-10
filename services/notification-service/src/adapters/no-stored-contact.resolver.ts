// ══════════════════════════════════════════════════════════════════
// notification-service — ContactResolver adapter (current production state)
//
// The applicant identity stores contact only as a one-way `phone_number_hash`
// (PII-minimisation — no plaintext, no encrypted contact today). There is
// therefore NO deliverable destination on file, so this resolver returns null
// for every applicant: delivery is recorded PENDING_NO_CONTACT and the
// lifecycle still advances (the physical test IS scheduled).
//
// This is the honest current state. A future "contact capture" slice will add
// an encrypted-at-rest phone/email + a PgContactResolver that decrypts it
// transactionally — at which point real delivery lights up with no change to
// the service's wiring (swap the adapter).
// ══════════════════════════════════════════════════════════════════

import type { ContactResolver, ResolvedContact } from '../ports/contact-resolver.js';

export class NoStoredContactResolver implements ContactResolver {
  async resolve(_applicantId: string): Promise<ResolvedContact | null> {
    return null;
  }
}
