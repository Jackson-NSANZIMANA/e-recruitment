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
