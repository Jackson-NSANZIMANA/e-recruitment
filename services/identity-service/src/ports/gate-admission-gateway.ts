// ══════════════════════════════════════════════════════════════════
// identity-service — GateAdmissionGateway port (BUILD-003, ADR-034)
//
// Forwards a gate admission to application-service WITH THE OFFICER'S OWN
// bearer token, so the owning service authorizes the real human (permission
// and agency) rather than trusting a service's say-so. Carries the national-id
// HASH, never the number.
// ══════════════════════════════════════════════════════════════════

export interface GateAdmissionRequest {
  readonly qrToken: string;
  readonly gateVenueName: string;
  readonly nationalIdHash: string;
}

/** application-service's status and parsed body, unprojected. */
export interface GateAdmissionUpstream {
  readonly status: number;
  readonly body: unknown;
}

export interface GateAdmissionGateway {
  /** Throws UpstreamUnavailableError when application-service cannot be reached. */
  admit(officerBearer: string, request: GateAdmissionRequest, correlationId: string): Promise<GateAdmissionUpstream>;
}
