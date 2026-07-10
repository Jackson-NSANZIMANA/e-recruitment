// ══════════════════════════════════════════════════════════════════
// notification-service — ContactResolver port
//
// Resolves an applicant to a DELIVERABLE contact (phone/email). The
// destination is PII — it is never logged, never placed on an event; it is
// used only to hand a message to a channel adapter and then discarded.
//
// IMPORTANT (flagged follow-on): today the system stores contact only as a
// one-way `phone_number_hash` (PII-minimisation — no plaintext), so the
// production resolver returns null for every applicant. Delivering a real
// invitation requires a dedicated "contact capture" slice that stores an
// encrypted-at-rest phone/email (consistent with the existing encrypted PII
// columns) — a compliance-relevant data-model decision left to the owner.
// ══════════════════════════════════════════════════════════════════

export interface ResolvedContact {
  readonly channel: 'SMS' | 'EMAIL';
  /** The phone number or email address. PII — never log or emit. */
  readonly destination: string;
}

export interface ContactResolver {
  /** Resolve a deliverable contact, or null when none is on file. Never throws for "not found". */
  resolve(applicantId: string): Promise<ResolvedContact | null>;
}
