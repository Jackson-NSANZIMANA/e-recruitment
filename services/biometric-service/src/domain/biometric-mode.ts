// ══════════════════════════════════════════════════════════════════
// biometric-service — Mode gate (pure, ADR-037 §7)
//
//   OFF       nothing is captured; the evidence operation refuses
//   SHADOW    stored, never shown, never used (accuracy measurement, B3)
//   ADVISORY  shown to the officer as identity evidence
//
// There is deliberately NO automatic mode. Adding one needs a new ADR and an
// owner and DPO decision; the union below is the whole vocabulary.
//
// The device states the mode it believes is in force. A disagreement is
// refused, so a device can never display a SHADOW result as if it counted.
// ══════════════════════════════════════════════════════════════════

export const BIOMETRIC_MODES = ['OFF', 'SHADOW', 'ADVISORY'] as const;
export type BiometricMode = (typeof BIOMETRIC_MODES)[number];

/** The modes in which a record can be stored (OFF captures nothing). */
export const RECORDING_MODES = ['SHADOW', 'ADVISORY'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export function isBiometricMode(value: unknown): value is BiometricMode {
  return typeof value === 'string' && (BIOMETRIC_MODES as readonly string[]).includes(value);
}

export type ModeGateDecision =
  | { readonly kind: 'RECORD'; readonly mode: RecordingMode }
  | { readonly kind: 'BIOMETRIC_OFF' }
  | { readonly kind: 'MODE_MISMATCH'; readonly configuredMode: RecordingMode };

/** PURE, TOTAL. `declared` is the record's mode (already parsed). */
export function modeGate(configured: BiometricMode, declared: RecordingMode): ModeGateDecision {
  switch (configured) {
    case 'OFF':
      return { kind: 'BIOMETRIC_OFF' };
    case 'SHADOW':
    case 'ADVISORY':
      return declared === configured
        ? { kind: 'RECORD', mode: configured }
        : { kind: 'MODE_MISMATCH', configuredMode: configured };
  }
}

/** Whether a stored record may be shown to an officer or used by the gate. */
export function isVisibleToOfficers(mode: RecordingMode): boolean {
  return mode === 'ADVISORY';
}
