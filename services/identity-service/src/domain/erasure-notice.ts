// ══════════════════════════════════════════════════════════════════
// identity-service — Erasure decision notice bodies (pure domain, ADR-022)
//
// Fixed strings, deliberately parameterless: PII-free by construction
// (owner D14c — the decline ground is officer free-text that may carry
// case detail, and SMS is an unauthenticated surface anyone holding the
// handset reads; the recorded ground stays behind the authenticated
// portal). The executed body does NOT point to the portal: erasure
// deleted the sessions and tombstoned the identity, so the citizen can
// no longer log in.
// ══════════════════════════════════════════════════════════════════

export function buildErasureDeclinedBody(): string {
  return [
    'USRP: your data-erasure request has been declined.',
    'The recorded ground for the decision is available in the applicant portal.',
  ].join('\n');
}

export function buildErasureExecutedBody(): string {
  return [
    'USRP: your data-erasure request has been executed.',
    'Your personal data has been removed from the recruitment platform.',
  ].join('\n');
}
