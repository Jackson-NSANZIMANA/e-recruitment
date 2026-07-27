// ══════════════════════════════════════════════════════════════════
// notification-service — ContactResolver port
//
// Resolves an applicant to a DELIVERABLE contact. The destination is PII —
// it is never logged, never placed on an event; it is used only to hand a
// message to the channel adapter and then discarded.
//
// Since ADR-021 the production resolver (PgContactResolver) decrypts the
// encrypted_phone_number captured at OTP verification. SMS is the only
// deliverable channel — no email source exists (owner D13a); an EMAIL
// channel would return here with its own port and resolver change.
// ══════════════════════════════════════════════════════════════════

export interface ResolvedContact {
  readonly channel: 'SMS';
  /** The phone number. PII — never log or emit. */
  readonly destination: string;
}

export interface ContactResolver {
  /** Resolve a deliverable contact, or null when none is on file. Never throws for "not found". */
  resolve(applicantId: string): Promise<ResolvedContact | null>;
}
