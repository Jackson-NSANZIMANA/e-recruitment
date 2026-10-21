// ADR-037: device evidence (v1.1) is never projected as a biometric verdict.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BiometricVerificationCompletedEvent } from '@usrp/shared-types';
import { isLegacyCheckInResult } from '../src/adapters/events/biometric-result.consumer.js';

const base = {
  eventId: '00000000-0000-4000-8000-000000000001',
  eventType: 'BIOMETRIC_VERIFICATION_COMPLETED',
  applicantId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  livenessScore: 0.99,
  livenessPass: true,
  faceMatchConfidence: 99,
  faceMatchPass: true,
} as unknown as BiometricVerificationCompletedEvent;

test('a legacy v1.0 check-in result is projected', () => {
  assert.equal(isLegacyCheckInResult(base), true);
});

test('a v1.1 evidence event is never projected, whatever its outcome', () => {
  for (const pass of [true, false]) {
    const evidence = {
      ...base,
      faceMatchPass: pass,
      schemaVersion: '1.1',
      recordId: base.sessionId,
      method: 'FACE_1_1_ON_DEVICE',
      referenceSource: 'CARD_PORTRAIT',
      mode: 'ADVISORY',
    } as BiometricVerificationCompletedEvent;
    assert.equal(isLegacyCheckInResult(evidence), false);
    assert.equal(isLegacyCheckInResult({ ...base, recordId: base.sessionId } as BiometricVerificationCompletedEvent), false);
  }
});
