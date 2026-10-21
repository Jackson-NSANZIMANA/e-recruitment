// ══════════════════════════════════════════════════════════════════
// edge-gateway — Operational read projections (ADR-039)
//
// Every answer is REBUILT from named fields. A field the upstream adds later
// cannot cross the boundary until it is named here, and a malformed upstream
// answer is a 502 (UPSTREAM_CONTRACT_MISMATCH), never a best-effort pass-through.
//
// NO function here can emit a name, a National ID or hash, an applicant id, an
// internal campaign id, a QR token or a phone number belonging to a candidate:
// none of those has a field below, and test/operational-projection.test.ts
// feeds hostile upstream bodies carrying every one of them.
// ══════════════════════════════════════════════════════════════════

class Mismatch extends Error {}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Mismatch();
  return v as Rec;
}
function str(v: unknown, max = 256): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Mismatch();
  return v;
}
function strOrNull(v: unknown, max = 256): string | null {
  return v === null ? null : str(v, max);
}
function token(v: unknown): string {
  const s = str(v, 64);
  if (!/^[A-Z][A-Z0-9_]*$/.test(s)) throw new Mismatch();
  return s;
}
function int(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Mismatch();
  return v;
}
function intOrNull(v: unknown): number | null {
  return v === null ? null : int(v);
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Mismatch();
  return v;
}
function instant(v: unknown): string {
  const s = str(v, 40);
  if (Number.isNaN(Date.parse(s))) throw new Mismatch();
  return s;
}
function instantOrNull(v: unknown): string | null {
  return v === null ? null : instant(v);
}
function day(v: unknown): string {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Mismatch();
  return s;
}
function list<T>(v: unknown, each: (item: unknown) => T, max = 5_000): T[] {
  if (!Array.isArray(v) || v.length > max) throw new Mismatch();
  return v.map(each);
}
function strings(v: unknown): string[] {
  return list(v, (s) => str(s));
}
function cursor(v: unknown): string | null {
  if (v === null) return null;
  const s = str(v, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Mismatch();
  return s;
}
function agency(v: unknown): string {
  const s = str(v, 3);
  if (s !== 'RDF' && s !== 'RNP' && s !== 'RCS') throw new Mismatch();
  return s;
}

function guard<T>(build: () => T): T | null {
  try {
    return build();
  } catch (error) {
    if (error instanceof Mismatch) return null;
    throw error;
  }
}

function summary(raw: unknown): Rec {
  const c = rec(raw);
  const o = rec(c['occupancy']);
  return {
    publicCode: str(c['publicCode'], 64),
    campaignLabel: str(c['campaignLabel'], 120),
    status: token(c['status']),
    targetCategories: strings(c['targetCategories']),
    targetDistricts: strings(c['targetDistricts']),
    registrationOpensAt: instant(c['registrationOpensAt']),
    registrationClosesAt: instant(c['registrationClosesAt']),
    examinationStartDate: day(c['examinationStartDate']),
    examinationEndDate: day(c['examinationEndDate']),
    allowsWalkIn: bool(c['allowsWalkIn']),
    targetIntakeCount: intOrNull(c['targetIntakeCount']),
    publishedAt: instantOrNull(c['publishedAt']),
    createdAt: instant(c['createdAt']),
    occupancy: {
      sessionCount: int(o['sessionCount']),
      capacityTotal: intOrNull(o['capacityTotal']),
      hasUnboundedSession: bool(o['hasUnboundedSession']),
      registeredTotal: int(o['registeredTotal']),
    },
  };
}

export function projectAgencyCampaignList(body: unknown): Rec | null {
  return guard(() => {
    const b = rec(body);
    return {
      agency: agency(b['agency']),
      campaigns: list(b['campaigns'], summary),
      total: int(b['total']),
      nextCursor: cursor(b['nextCursor']),
    };
  });
}

export function projectCampaignAdminDetail(body: unknown): Rec | null {
  return guard(() => {
    const b = rec(body);
    const c = rec(b['campaign']);
    const policy = c['policy'] === null ? null : rec(c['policy']);
    const coverage = c['coverage'] === null ? null : rec(c['coverage']);
    return {
      agency: agency(b['agency']),
      campaign: {
        ...summary(c),
        contactPhoneNumbers: c['contactPhoneNumbers'] === null ? null : strings(c['contactPhoneNumbers']),
        contactWebsite: strOrNull(c['contactWebsite']),
        announcementReference: strOrNull(c['announcementReference']),
        registrationClosedAt: instantOrNull(c['registrationClosedAt']),
        cancelledAt: instantOrNull(c['cancelledAt']),
        policy: policy === null ? null : {
          versionNumber: int(policy['versionNumber']),
          policyHash: str(policy['policyHash'], 64),
          hashVersion: int(policy['hashVersion']),
          legalBasisCode: str(policy['legalBasisCode'], 64),
          createdAt: instant(policy['createdAt']),
        },
        coverage: coverage === null ? null : { version: int(coverage['version']), hash: str(coverage['hash'], 64) },
        sessions: list(c['sessions'], (raw) => {
          const s = rec(raw);
          return {
            district: token(s['district']),
            province: token(s['province']),
            venueName: str(s['venueName'], 200),
            examDate: day(s['examDate']),
            reportingTimeHour: int(s['reportingTimeHour']),
            capacityLimit: intOrNull(s['capacityLimit']),
            capacityDecisionCode: s['capacityDecisionCode'] === null ? null : token(s['capacityDecisionCode']),
            registeredCount: int(s['registeredCount']),
            remaining: intOrNull(s['remaining']),
            isActive: bool(s['isActive']),
          };
        }, 500),
        history: list(c['history'], (raw) => {
          const h = rec(raw);
          return {
            fromStatus: h['fromStatus'] === null ? null : token(h['fromStatus']),
            toStatus: token(h['toStatus']),
            reasonCode: h['reasonCode'] === null ? null : token(h['reasonCode']),
            occurredAt: instant(h['occurredAt']),
          };
        }, 500),
      },
    };
  });
}

export function projectApplicationSearch(body: unknown): Rec | null {
  return guard(() => {
    const b = rec(body);
    return {
      agency: agency(b['agency']),
      applications: list(b['applications'], (raw) => {
        const a = rec(raw);
        return {
          applicationId: str(a['applicationId'], 36),
          processingCode: str(a['processingCode'], 20),
          category: token(a['category']),
          status: token(a['status']),
          submittedAt: instantOrNull(a['submittedAt']),
        };
      }, 200),
      total: int(b['total']),
      nextCursor: cursor(b['nextCursor']),
    };
  });
}

export function projectVenueRoster(body: unknown): Rec | null {
  return guard(() => {
    const b = rec(body);
    const v = rec(b['venue']);
    return {
      agency: agency(b['agency']),
      venue: {
        venueName: str(v['venueName'], 200),
        district: token(v['district']),
        examDate: day(v['examDate']),
        reportingTimeHour: int(v['reportingTimeHour']),
        capacityLimit: intOrNull(v['capacityLimit']),
        registeredCount: int(v['registeredCount']),
      },
      candidates: list(b['candidates'], (raw) => {
        const c = rec(raw);
        const admission = token(c['admission']);
        if (admission !== 'ADMITTED' && admission !== 'NOT_ADMITTED') throw new Mismatch();
        return {
          processingCode: str(c['processingCode'], 20),
          category: token(c['category']),
          status: token(c['status']),
          admission,
          requiredPaperItems: list(c['requiredPaperItems'], token, 32),
        };
      }, 2_000),
      truncated: bool(b['truncated']),
    };
  });
}

/** The DPO queue: request id and age. The applicant id is NEVER forwarded. */
export function projectErasureQueue(body: unknown): { requests: Rec[] } | null {
  return guard(() => ({
    requests: list(rec(body)['requests'], (raw) => {
      const r = rec(raw);
      return { requestId: str(r['requestId'], 36), requestedAt: instant(r['requestedAt']) };
    }, 1_000),
  }));
}

// ── S09: device fleet and venue live counts ────────────────────────
const SEEN_SOURCES: ReadonlySet<string> = new Set(['FIELD_SYNC', 'BIOMETRIC']);
const REVOKE_REASON_CODES: ReadonlySet<string> = new Set(['LOST', 'STOLEN', 'COMPROMISED', 'RETIRED', 'OTHER']);

/**
 * The fleet list. A device is its id, who enrolled it, when it was last heard
 * from and whether it is revoked. The public key never has a field here; the
 * agency is the session's, so none is echoed.
 */
export function projectFleetDevices(body: unknown): { devices: Rec[] } | null {
  return guard(() => ({
    devices: list(rec(body)['devices'], (raw) => {
      const d = rec(raw);
      const seenSource = d['lastSeenSource'] === null ? null : token(d['lastSeenSource']);
      if (seenSource !== null && !SEEN_SOURCES.has(seenSource)) throw new Mismatch();
      const reason = d['revokeReason'] === null ? null : token(d['revokeReason']);
      if (reason !== null && !REVOKE_REASON_CODES.has(reason)) throw new Mismatch();
      const revokedAt = instantOrNull(d['revokedAt']);
      const a = d['assignment'] === null ? null : rec(d['assignment']);
      return {
        deviceId: str(d['deviceId'], 64),
        enrolledBy: str(d['enrolledBy'], 128),
        enrolledAt: instant(d['enrolledAt']),
        lastSeenAt: instantOrNull(d['lastSeenAt']),
        lastSeenSource: seenSource,
        lastSyncAt: instantOrNull(d['lastSyncAt']),
        revoked: revokedAt !== null,
        revokedAt,
        revokeReason: reason,
        assignment:
          a === null
            ? null
            : { campaign: str(a['campaignPublicCode'], 64), district: token(a['district']), examDate: day(a['examDate']) },
      };
    }, 500),
  }));
}

/** Counts and the instant they were last recomputed. No candidate row exists in this shape. */
export function projectVenueLiveCounts(body: unknown): Rec | null {
  return guard(() => {
    const b = rec(body);
    const v = rec(b['venue']);
    const c = rec(b['counts']);
    return {
      agency: agency(b['agency']),
      venue: { venueName: str(v['venueName'], 200), district: token(v['district']), examDate: day(v['examDate']) },
      counts: {
        expected: int(c['expected']),
        admitted: int(c['admitted']),
        physicalCaptured: int(c['physicalCaptured']),
        medicalRecorded: int(c['medicalRecorded']),
        openConflicts: int(c['openConflicts']),
      },
      asOf: instantOrNull(b['asOf']),
    };
  });
}
