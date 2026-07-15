// ══════════════════════════════════════════════════════════════════
// document-forensics-service — AnalyzeDocument use case
//
// The amber lane's front half: given a document REFERENCE (application +
// agency + type + object key), fetch the real bytes, analyze them, record
// the verdict on the owning agency's document_records, and emit ONE
// DOCUMENT_FORENSICS_COMPLETED (the routing projection's trigger) plus ONE
// PII-free AUDIT_ENTRY. Business outcomes are return values; only infra
// faults throw. Fail-closed at every step: unknown app → no write; missing
// object → no write; scanner down → no verdict, no event — a lane is never
// fabricated (the whole point of a forensics service).
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type {
  Agency,
  AuditEvent,
  DocumentForensicsCompletedEvent,
  DocumentType,
} from '@usrp/shared-types';
import { isDocumentTypeSupported } from '../domain/agency-documents.js';
import type { DocumentRecordStore } from '../ports/document-record-store.js';
import type { ForensicsAnalyzer, ForensicsVerdict } from '../ports/forensics-analyzer.js';
import type { ObjectStore } from '../ports/object-store.js';

export interface AnalyzeDocumentCommand {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly documentType: DocumentType;
  readonly objectBucket: string;
  readonly objectKey: string;
  readonly context: EventContext;
}

export type AnalyzeDocumentOutcome =
  | { readonly kind: 'ANALYZED'; readonly documentId: string; readonly verdict: ForensicsVerdict }
  | { readonly kind: 'APPLICATION_NOT_FOUND' }
  | { readonly kind: 'OBJECT_NOT_FOUND' }
  | { readonly kind: 'UNSUPPORTED_DOCUMENT_TYPE' }
  | { readonly kind: 'SCANNER_UNAVAILABLE'; readonly detail: string };

export interface AnalyzeDocumentDeps {
  readonly objectStore: ObjectStore;
  readonly analyzer: ForensicsAnalyzer;
  readonly recordStore: DocumentRecordStore;
  readonly eventBus: EventBus;
}

export class AnalyzeDocumentService {
  readonly #deps: AnalyzeDocumentDeps;

  constructor(deps: AnalyzeDocumentDeps) {
    this.#deps = deps;
  }

  async analyze(command: AnalyzeDocumentCommand): Promise<AnalyzeDocumentOutcome> {
    // Each agency's document_type enum genuinely differs — reject a type the
    // owning agency does not model as a clean outcome, not a DB cast error.
    if (!isDocumentTypeSupported(command.agency, command.documentType)) {
      return { kind: 'UNSUPPORTED_DOCUMENT_TYPE' };
    }

    const bytes = await this.#deps.objectStore.getObject(command.objectBucket, command.objectKey);
    if (bytes === null) return { kind: 'OBJECT_NOT_FOUND' };

    const analysis = await this.#deps.analyzer.analyze(bytes);
    if (analysis.kind === 'SCANNER_UNAVAILABLE') {
      // Fail closed: no verdict is recorded and no event is emitted — a
      // document is never laned by a scanner we could not reach.
      return { kind: 'SCANNER_UNAVAILABLE', detail: analysis.detail };
    }

    const recorded = await this.#deps.recordStore.recordVerdict({
      applicationId: command.applicationId,
      agency: command.agency,
      documentType: command.documentType,
      objectBucket: command.objectBucket,
      objectKey: command.objectKey,
      fileSizeBytes: bytes.length,
      virusScanStatus: analysis.verdict.flags.virusScanClean ? 'CLEAN' : 'INFECTED',
      verdict: analysis.verdict,
    });
    if (recorded.kind === 'APPLICATION_NOT_FOUND') return { kind: 'APPLICATION_NOT_FOUND' };

    const result: DocumentForensicsCompletedEvent = {
      ...newEnvelope(command.context),
      eventType: 'DOCUMENT_FORENSICS_COMPLETED',
      applicationId: command.applicationId,
      agency: command.agency,
      documentId: recorded.documentId,
      documentType: command.documentType,
      lane: analysis.verdict.lane,
      forensicsScore: analysis.verdict.score,
      flags: analysis.verdict.flags,
    };
    await this.#deps.eventBus.publish(result);

    const audit: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action: 'DOCUMENT_FORENSICS_COMPLETED',
      performedBy: 'document-forensics-service',
      agency: command.agency,
      metadata: {
        documentId: recorded.documentId,
        documentType: command.documentType,
        lane: analysis.verdict.lane,
        forensicsScore: analysis.verdict.score,
        virusScanClean: analysis.verdict.flags.virusScanClean,
      },
    };
    await this.#deps.eventBus.publish(audit);

    return { kind: 'ANALYZED', documentId: recorded.documentId, verdict: analysis.verdict };
  }
}
