// ══════════════════════════════════════════════════════════════════
// notification-service — Invitation rendering (pure domain)
//
// Builds the applicant-facing invitation body from the PII-free fields of a
// SLOT_ASSIGNED event. The signed QR token IS the credential the applicant
// presents at the venue; the rest is human-readable logistics. Pure and
// total — no I/O, no clock.
// ══════════════════════════════════════════════════════════════════

export interface SlotInvitationContent {
  readonly venueName: string;
  readonly examDate: string;          // ISO date (YYYY-MM-DD)
  readonly reportingTimeHour: number; // 0–23
  readonly qrSignedToken: string;     // Ed25519 offline-verifiable QR credential
}

/** Render the invitation message body. Contains no PII (no name/NID/phone). */
export function buildInvitationBody(content: SlotInvitationContent): string {
  const hh = String(content.reportingTimeHour).padStart(2, '0');
  return [
    'USRP recruitment: your physical-test slot is confirmed.',
    `Venue: ${content.venueName}`,
    `Date: ${content.examDate}  Report by: ${hh}:00`,
    'Present this QR at check-in:',
    content.qrSignedToken,
  ].join('\n');
}

/** The PII-free facts of an auto-withdrawal a notice is rendered from (ADR-022). */
export interface WithdrawalNoticeContent {
  readonly acceptedByAgency: string;
  /** Agencies of the retired applications, in event order (may repeat). */
  readonly withdrawnAgencies: readonly string[];
}

/**
 * Render the withdrawal notice body. Agency names and a count only — no
 * application ids (opaque UUIDs are useless on a handset), no name/NID/phone.
 */
export function buildWithdrawalNoticeBody(content: WithdrawalNoticeContent): string {
  const n = content.withdrawnAgencies.length;
  const plural = n === 1 ? 'application' : 'applications';
  return [
    `USRP recruitment: congratulations — you have been accepted by ${content.acceptedByAgency}.`,
    `As a result, your ${n} other in-flight ${plural} (${content.withdrawnAgencies.join(', ')}) ${n === 1 ? 'has' : 'have'} been withdrawn.`,
    'Details are available in the applicant portal.',
  ].join('\n');
}
