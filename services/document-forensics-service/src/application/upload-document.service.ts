// ══════════════════════════════════════════════════════════════════
// document-forensics-service — UploadDocument use case (P1 endpoint 3)
//
// The citizen-facing front half of the amber lane: real bytes arrive, get
// scanned, get sealed into MinIO, get a verdict row, and the routing projection
// fires — all in one request. Until this existed, MinIO buckets and encryption
// keys were provisioned and the wizard's certificate upload had nowhere to send
// bytes at all.
//
// ── SCAN BEFORE STORE (ADR-004), AND THE TRAP INSIDE IT ──────────────
//
// Sequence: ownership → admission → SCAN → store → record → emit. An INFECTED
// upload therefore leaves AN AUDIT EVENT AND NOTHING ELSE — no object, no row.
//
// The "no row" half is not tidiness. document_records keys idempotency on
// (application_id, minio_object_key), and the key is DERIVED and STABLE. A row
// written for a rejected upload would make the citizen's NEXT, legitimate
// upload of that document type look like a re-analysis of an object that was
// never stored — and analyze/ would then 404 on a document the officer console
// can see listed.
//
// FOR THE SAME REASON THE INFECTED PATH EMITS NO DOCUMENT_FORENSICS_COMPLETED.
// That event carries a documentId which application-service's projection
// dereferences; a RED lane with no row behind it is a poison message that
// retries forever. Malware rejection is an AUDIT fact, not a lane. A stored
// document that scans dirty IS a lane — which is exactly what analyze/ still
// emits. One is a door refusing entry; the other is a verdict on something
// already inside.
//
// ── WHY ADMISSION IS STRICTER HERE THAN IN analyze/ ──────────────────
//
// analyze/ tolerates an unidentifiable container and lanes it AMBER, which is
// right for an object that arrived by some other route and must now be judged.
// An INGRESS can simply refuse. Unidentifiable bytes and bytes that contradict
// the declared media type are rejected at the door rather than stored as a
// permanent AMBER for a human to adjudicate. A PNG-declared PDF is a polyglot
// attempt, not a user mistake.
//
// The pure probe therefore runs twice — once here to admit, once inside the
// analyzer to score. It is pure, total and cheap, and the admission rule must
// not depend on the analyzer's internal ordering.
//
// Business outcomes are RETURN VALUES; only infra faults throw. Fail-closed at
// every step: unknown owner → no write; scanner down → no verdict, no event,
// nothing stored. A lane is never fabricated.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type {
  Agency,
  AuditEvent,
  DocumentForensicsCompletedEvent,
  DocumentType,
} from '@usrp/shared-types';
import { isDocumentTypeSupported } from '../domain/agency-documents.js';
import { probeBytes, type ContainerFormat } from '../domain/forensics.js';
import { deriveObjectKey } from '../domain/object-key.js';
import type { ApplicationOwnershipReader } from '../ports/application-ownership-reader.js';
import type { DocumentRecordStore } from '../ports/document-record-store.js';
import type { ForensicsAnalyzer, ForensicsVerdict } from '../ports/forensics-analyzer.js';
import type { ObjectStoreWrite } from '../ports/object-store-write.js';

/**
 * Declared media type → the container the bytes must actually be.
 * FORENSICS_ALLOWED_MIME_TYPES gates which of these the deployment accepts;
 * this map is what makes "declared" and "actual" comparable at all.
 */
const MEDIA_TYPE_CONTAINER: Readonly<Record<string, ContainerFormat>> = {
  'image/jpeg': 'JPEG',
  'image/jpg': 'JPEG', // non-standard but widely emitted by phone cameras
  'image/png': 'PNG',
  'application/pdf': 'PDF',
};

/**
 * Statuses that refuse new documents. Compared as TEXT: WALK_IN_REJECTED exists
 * only in rdf_ops, so an enum-cast comparison against this set is a hard error
 * for RNP and RCS officers (the ADR-017 idiom).
 */
const CLOSED_TO_UPLOADS: readonly string[] = [
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'WALK_IN_REJECTED',
];

export interface UploadDocumentCommand {
  /** The authenticated citizen, per the edge that resolved their session. */
  readonly applicantId: string;
  readonly applicationId: string;
  readonly documentType: DocumentType;
  /** The part's declared Content-Type. Checked AGAINST the bytes, not trusted. */
  readonly declaredMediaType: string;
  readonly bytes: Buffer;
  readonly context: EventContext;
}

export type UploadDocumentOutcome =
  | {
      readonly kind: 'UPLOADED';
      readonly documentId: string;
      readonly agency: Agency;
      readonly objectKey: string;
      /**
       * The real verdict. The USE CASE reports it honestly; the CONTROLLER
       * decides disclosure and deliberately withholds it from a citizen-facing
       * response (a score returned to the uploader is a forgery-tuning oracle).
       */
      readonly verdict: ForensicsVerdict;
    }
  /** No such application, or it belongs to another citizen — the same answer. */
  | { readonly kind: 'APPLICATION_NOT_FOUND' }
  | { readonly kind: 'NOT_ACCEPTING_DOCUMENTS'; readonly agency: Agency; readonly status: string }
  | { readonly kind: 'UNSUPPORTED_DOCUMENT_TYPE'; readonly agency: Agency }
  /** The bytes are not a container this system can identify at all. */
  | { readonly kind: 'UNSUPPORTED_CONTENT'; readonly detected: ContainerFormat }
  /** The bytes contradict the declared media type — polyglot / mislabel. */
  | {
      readonly kind: 'CONTENT_TYPE_MISMATCH';
      readonly declared: string;
      readonly detected: ContainerFormat;
    }
  /** ClamAV flagged the bytes. Nothing was stored. */
  | { readonly kind: 'MALWARE_DETECTED' }
  | { readonly kind: 'SCANNER_UNAVAILABLE'; readonly detail: string };

export interface UploadDocumentDeps {
  readonly ownership: ApplicationOwnershipReader;
  readonly analyzer: ForensicsAnalyzer;
  readonly objectWriter: ObjectStoreWrite;
  readonly recordStore: DocumentRecordStore;
  readonly eventBus: EventBus;
  /** Destination bucket (MINIO_BUCKET_DOCUMENTS). */
  readonly bucket: string;
}

export class UploadDocumentService {
  readonly #deps: UploadDocumentDeps;

  constructor(deps: UploadDocumentDeps) {
    this.#deps = deps;
  }

  async upload(command: UploadDocumentCommand): Promise<UploadDocumentOutcome> {
    // ── 1. Ownership decides the agency. The request never gets a say. ──
    const owned = await this.#deps.ownership.findOwnedApplication({
      applicantId: command.applicantId,
      applicationId: command.applicationId,
    });
    if (owned === null) return { kind: 'APPLICATION_NOT_FOUND' };
    const { agency } = owned;

    if (CLOSED_TO_UPLOADS.includes(owned.status)) {
      return { kind: 'NOT_ACCEPTING_DOCUMENTS', agency, status: owned.status };
    }

    // Each agency's document_type enum genuinely differs — a clean outcome,
    // never a raw enum-cast DB error.
    if (!isDocumentTypeSupported(agency, command.documentType)) {
      return { kind: 'UNSUPPORTED_DOCUMENT_TYPE', agency };
    }

    // ── 2. Admission on the REAL bytes, before a scan is paid for. ──
    const signals = probeBytes(command.bytes);
    if (signals.container === 'UNKNOWN') {
      return { kind: 'UNSUPPORTED_CONTENT', detected: signals.container };
    }
    const expected = MEDIA_TYPE_CONTAINER[command.declaredMediaType];
    if (expected !== signals.container) {
      return {
        kind: 'CONTENT_TYPE_MISMATCH',
        declared: command.declaredMediaType,
        detected: signals.container,
      };
    }

    // ── 3. SCAN. Nothing has touched durable storage yet. ──
    const analysis = await this.#deps.analyzer.analyze(command.bytes);
    if (analysis.kind === 'SCANNER_UNAVAILABLE') {
      // Fail closed: no object, no row, no event. A document is never accepted
      // by a scanner we could not reach.
      return { kind: 'SCANNER_UNAVAILABLE', detail: analysis.detail };
    }

    const objectKey = deriveObjectKey(agency, command.applicationId, command.documentType);

    if (!analysis.verdict.flags.virusScanClean) {
      // Infected: the ONLY artefact is an audit fact. No object reaches MinIO,
      // no document_records row is created (it would poison the idempotency
      // key for the citizen's next, legitimate upload), and NO forensics event
      // is emitted (it would carry a documentId the projection cannot resolve).
      await this.#deps.eventBus.publish(
        this.#audit(command, agency, 'DOCUMENT_UPLOAD_REJECTED_MALWARE', {
          documentType: command.documentType,
          fileSizeBytes: command.bytes.length,
          // The signature stays behind the ForensicsAnalyzer port on purpose:
          // widening that port for one log line would put a scanner-specific
          // string into the contract the deferred perceptual tier must honour.
          reason: 'MALWARE_DETECTED',
        }),
      );
      return { kind: 'MALWARE_DETECTED' };
    }

    // ── 4. Store, THEN record. Order matters. ──
    // The object must exist before a row points at it: a row without an object
    // makes analyze/ report OBJECT_NOT_FOUND for a document the console lists.
    // The reverse order is safely retryable — the key is derived, so a retry
    // overwrites the same object and UPDATEs the same row.
    await this.#deps.objectWriter.putObject(this.#deps.bucket, objectKey, command.bytes);

    const recorded = await this.#deps.recordStore.recordVerdict({
      applicationId: command.applicationId,
      agency,
      documentType: command.documentType,
      objectBucket: this.#deps.bucket,
      objectKey,
      fileSizeBytes: command.bytes.length,
      virusScanStatus: 'CLEAN',
      verdict: analysis.verdict,
    });
    if (recorded.kind === 'APPLICATION_NOT_FOUND') {
      // Defence in depth: the ownership read already proved the row exists in
      // this agency's schema, so reaching here means it was deleted mid-flight.
      return { kind: 'APPLICATION_NOT_FOUND' };
    }

    // ── 5. Emit: the lane (routing projection) + the audit fact. ──
    const forensics: DocumentForensicsCompletedEvent = {
      ...newEnvelope(command.context),
      eventType: 'DOCUMENT_FORENSICS_COMPLETED',
      applicationId: command.applicationId,
      agency,
      documentId: recorded.documentId,
      documentType: command.documentType,
      lane: analysis.verdict.lane,
      forensicsScore: analysis.verdict.score,
      flags: analysis.verdict.flags,
    };
    await this.#deps.eventBus.publish(forensics);

    await this.#deps.eventBus.publish(
      this.#audit(command, agency, 'DOCUMENT_UPLOADED', {
        documentId: recorded.documentId,
        documentType: command.documentType,
        fileSizeBytes: command.bytes.length,
        lane: analysis.verdict.lane,
        forensicsScore: analysis.verdict.score,
        c2paManifestPresent: signals.hasC2paManifest,
        encryptedAtRest: true,
      }),
    );

    return {
      kind: 'UPLOADED',
      documentId: recorded.documentId,
      agency,
      objectKey,
      verdict: analysis.verdict,
    };
  }

  /**
   * PII-FREE BY CONSTRUCTION. performedBy is 'APPLICANT' — the citizen's own
   * authority carried by the edge, the same actor label ADR-020's self
   * withdrawal writes — and the applicant id never enters the metadata. The
   * anonymous application id stands in for the person, as everywhere else.
   */
  #audit(
    command: UploadDocumentCommand,
    agency: Agency,
    action: string,
    metadata: Record<string, unknown>,
  ): AuditEvent {
    return {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action,
      performedBy: 'APPLICANT',
      agency,
      metadata,
    };
  }
}
