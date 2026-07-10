// ══════════════════════════════════════════════════════════════════
// identity-service — Project biometric result (use case)
//
// identity-service owns public_core.applicant_identities, so it is the writer
// of the biometric_* columns. This projection consumes the biometric.result
// event (emitted by biometric-service, which owns the check) and records the
// scores/verdict onto the identity. Overall "verified" = liveness AND face
// match. Idempotent; a mis-routed applicant is a silent no-op ('not_found').
// ══════════════════════════════════════════════════════════════════

import type { IdentityRepository } from '../ports/identity.repository.js';

export interface ProjectBiometricResultCommand {
  readonly applicantId: string;
  readonly sessionId: string;
  readonly livenessPass: boolean;
  readonly faceMatchPass: boolean;
  readonly faceMatchConfidence: number;
}

export interface ProjectBiometricResultDeps {
  readonly repository: IdentityRepository;
}

export class ProjectBiometricResultService {
  constructor(private readonly deps: ProjectBiometricResultDeps) {}

  async project(command: ProjectBiometricResultCommand): Promise<'updated' | 'not_found'> {
    return this.deps.repository.recordBiometricResult({
      applicantId: command.applicantId,
      sessionId: command.sessionId,
      verified: command.livenessPass && command.faceMatchPass,
      passedLiveness: command.livenessPass,
      faceMatchConfidence: command.faceMatchConfidence,
    });
  }
}
