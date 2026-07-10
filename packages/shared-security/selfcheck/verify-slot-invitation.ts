// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Signed slot-invitation self-check (ADR-009)
//
// A DETERMINISTIC, infra-free proof of the verifiable-QR credential: the real
// gate for this crypto (no Kafka/PG needed — it exercises the pure functions).
//
//   • sign → verify round-trips and the claims survive byte-for-byte;
//   • a tampered payload, a tampered signature, and a wrong public key are ALL
//     rejected (returns null, never throws);
//   • an expired invitation is rejected; a live one is accepted;
//   • malformed tokens are rejected;
//   • the token is URL-safe (QR/URL transportable) and the claims carry NO PII.
//
//   npx tsx packages/shared-security/selfcheck/verify-slot-invitation.ts
// ══════════════════════════════════════════════════════════════════

import type { SlotInvitationClaims } from '@usrp/shared-types';
import { generateDeviceKeyPair, signSlotInvitation, verifySlotInvitation } from '../src/index.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// A frozen clock so the expiry assertions are deterministic.
const NOW = new Date('2026-06-04T06:00:00.000Z');
const BEFORE_EXAM = { now: NOW };

const CLAIMS: SlotInvitationClaims = {
  v: 1,
  keyId: 'slot-key-2026',
  ticketId: 'r4Nd0m-t1cket-id-000',
  applicationId: '11111111-1111-4111-8111-111111111111',
  applicantId: '22222222-2222-4222-8222-222222222222',
  agency: 'RDF',
  campaignId: '33333333-3333-4333-8333-333333333333',
  slotId: '44444444-4444-4444-8444-444444444444',
  venueName: 'ULK Stadium',
  examDate: '2026-06-04',
  reportingTimeHour: 8,
  issuedAt: '2026-05-01T09:00:00.000Z',
  expiresAt: '2026-06-04T23:59:59.000Z',
};

function main(): void {
  const keys = generateDeviceKeyPair();
  const token = signSlotInvitation(keys.privateKeyPem, CLAIMS);

  console.log('\n── 1. Round-trip ───────────────────────────────────────────');
  check('token is namespaced + versioned', token.startsWith('USRP-SLOT.v1.'));
  check('token has 4 dot-segments', token.split('.').length === 4, token.split('.').length.toString());
  const verified = verifySlotInvitation(keys.publicKeyPem, token, BEFORE_EXAM);
  check('valid token verifies', verified !== null);
  // Content survives exactly (verify decodes canonical/key-sorted JSON, so
  // compare by value, not by textual key order).
  const sameContent =
    verified !== null &&
    Object.keys(CLAIMS).length === Object.keys(verified).length &&
    (Object.keys(CLAIMS) as (keyof SlotInvitationClaims)[]).every((k) => verified[k] === CLAIMS[k]);
  check('claims survive round-trip by value', sameContent, JSON.stringify(verified));

  console.log('\n── 2. Tamper + wrong-key rejection ──────────────────────────');
  // Flip the last signature chars → signature no longer matches.
  const tamperedSig = `${token.slice(0, -4)}${token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  check('tampered signature rejected', verifySlotInvitation(keys.publicKeyPem, tamperedSig, BEFORE_EXAM) === null);

  // Mutate a claim in the payload segment → signature no longer covers it.
  const parts = token.split('.');
  const forgedClaims = { ...CLAIMS, reportingTimeHour: 6 };
  const forgedPayload = Buffer.from(JSON.stringify(forgedClaims), 'utf8').toString('base64url');
  const forgedToken = `${parts[0]}.${parts[1]}.${forgedPayload}.${parts[3]}`;
  check('mutated payload rejected', verifySlotInvitation(keys.publicKeyPem, forgedToken, BEFORE_EXAM) === null);

  const otherKeys = generateDeviceKeyPair();
  check('wrong public key rejected', verifySlotInvitation(otherKeys.publicKeyPem, token, BEFORE_EXAM) === null);

  console.log('\n── 3. Expiry ────────────────────────────────────────────────');
  check('accepted before expiry', verifySlotInvitation(keys.publicKeyPem, token, BEFORE_EXAM) !== null);
  check(
    'rejected after expiry',
    verifySlotInvitation(keys.publicKeyPem, token, { now: new Date('2026-06-05T00:00:01.000Z') }) === null,
  );

  console.log('\n── 4. Malformed input never throws ──────────────────────────');
  check('empty token rejected', verifySlotInvitation(keys.publicKeyPem, '', BEFORE_EXAM) === null);
  check('3-segment token rejected', verifySlotInvitation(keys.publicKeyPem, 'USRP-SLOT.v1.abc', BEFORE_EXAM) === null);
  check(
    'wrong namespace rejected',
    verifySlotInvitation(keys.publicKeyPem, token.replace('USRP-SLOT', 'EVIL-NS'), BEFORE_EXAM) === null,
  );

  console.log('\n── 5. Transport + PII safety ────────────────────────────────');
  check('token is URL/QR-safe (base64url + dots only)', /^[A-Za-z0-9._-]+$/.test(token), token.slice(0, 24));
  // The signed payload must not carry raw PII: no home district / DOB / name / NID.
  const payloadSegment = parts[2] ?? '';
  const payloadJson = Buffer.from(payloadSegment, 'base64url').toString('utf8');
  check('payload carries only the whitelisted claim keys', arePiiFree(JSON.parse(payloadJson) as Record<string, unknown>));

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('SIGNED SLOT INVITATION PROVEN (deterministic) ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

/** The claim set is a closed whitelist — any extra key is a leak risk. */
function arePiiFree(claims: Record<string, unknown>): boolean {
  const allowed = new Set([
    'v', 'keyId', 'ticketId', 'applicationId', 'applicantId', 'agency',
    'campaignId', 'slotId', 'venueName', 'examDate', 'reportingTimeHour',
    'issuedAt', 'expiresAt',
  ]);
  return Object.keys(claims).every((k) => allowed.has(k));
}

main();
process.exit(failures === 0 ? 0 : 1);
