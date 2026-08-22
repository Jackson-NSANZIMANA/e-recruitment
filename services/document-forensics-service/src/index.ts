// ══════════════════════════════════════════════════════════════════
// @usrp/document-forensics-service — Public API & composition root
//
// Wires the hexagonal core to its real adapters: MinIO retrieval AND the new
// sealed write path (both on one hand-rolled SigV4 signer), the bounded-real
// analyzer (ClamAV + pure byte probe), the PostgreSQL document_records store,
// and the cross-agency ownership reader the upload ingress derives its agency
// from. The caller supplies the EventBus (InMemory in proofs, Kafka in
// production) — the use cases never know which. Transport lives in main.ts.
//
// ONE ENVELOPE KEY, DERIVED ONCE, HANDED TO BOTH HALVES OF THE STORE. What the
// writer seals is exactly what the reader can open; deriving it twice from the
// same secret would work today and diverge the moment one call site changes its
// HKDF info string.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { MinioObjectStore } from './adapters/minio.object-store.js';
import { MinioObjectWriter } from './adapters/minio.object-writer.js';
import { ClamavVirusScanner } from './adapters/clamav.virus-scanner.js';
import { BoundedRealAnalyzer } from './adapters/bounded-real.analyzer.js';
import { PgDocumentRecordStore } from './adapters/document-record.pg-store.js';
import { PgApplicationOwnershipReader } from './adapters/application-ownership.pg-reader.js';
import { AnalyzeDocumentService } from './application/analyze-document.service.js';
import { UploadDocumentService } from './application/upload-document.service.js';
import { deriveEnvelopeKey } from './domain/document-envelope.js';
import type { DocumentForensicsConfig } from './config.js';

export interface DocumentForensicsService {
  /** HTTP ingress — analyze a REFERENCED document (POST /v1/forensics/analyze). */
  readonly analyzeDocument: AnalyzeDocumentService;
  /**
   * HTTP ingress — INGEST real bytes from the citizen portal via the edge
   * (POST /v1/documents/upload): scan → seal → store → verdict → emit.
   */
  readonly uploadDocument: UploadDocumentService;
}

export function createDocumentForensicsService(
  config: DocumentForensicsConfig,
  eventBus: EventBus,
): DocumentForensicsService {
  const envelopeKey = deriveEnvelopeKey(config.ingress.encryptionKey);
  const objectStore = new MinioObjectStore(config.objectStore, envelopeKey);
  const objectWriter = new MinioObjectWriter(config.objectStore, envelopeKey);
  const scanner = new ClamavVirusScanner(config.scanner);
  const analyzer = new BoundedRealAnalyzer(scanner);
  const recordStore = new PgDocumentRecordStore();

  return {
    analyzeDocument: new AnalyzeDocumentService({
      objectStore,
      analyzer,
      recordStore,
      eventBus,
    }),
    uploadDocument: new UploadDocumentService({
      ownership: new PgApplicationOwnershipReader(),
      analyzer,
      objectWriter,
      recordStore,
      eventBus,
      bucket: config.ingress.bucket,
    }),
  };
}

// ── Re-exports ────────────────────────────────────────────
// The PATH CONSTANTS are public on purpose: the edge tier maps a REST-shaped
// browser route onto the real upstream path, and a hard-coded string there is
// the same drift class that pointed the frontend doc at :4001.
export {
  ANALYZE_DOCUMENT_PATH,
  analyzeDocumentRoute,
} from './adapters/http/analyze-document.controller.js';
export {
  UPLOAD_DOCUMENT_PATH,
  uploadDocumentRoute,
} from './adapters/http/upload-document.controller.js';
export type { UploadRouteOptions } from './adapters/http/upload-document.controller.js';
export { AnalyzeDocumentService } from './application/analyze-document.service.js';
export type {
  AnalyzeDocumentCommand,
  AnalyzeDocumentDeps,
  AnalyzeDocumentOutcome,
} from './application/analyze-document.service.js';
export { UploadDocumentService } from './application/upload-document.service.js';
export type {
  UploadDocumentCommand,
  UploadDocumentDeps,
  UploadDocumentOutcome,
} from './application/upload-document.service.js';
export { composeVerdict, probeBytes } from './domain/forensics.js';
export type { ByteSignals, ContainerFormat, VerdictSignals } from './domain/forensics.js';
export { AGENCY_DOCUMENT_TYPES, isDocumentTypeSupported } from './domain/agency-documents.js';
export { AGENCY_SCHEMA, SYSTEM_ROLE, schemaForAgency } from './domain/agency-schema.js';
export type { OpsSchema } from './domain/agency-schema.js';
export { deriveObjectKey } from './domain/object-key.js';
export {
  DocumentEnvelopeError,
  deriveEnvelopeKey,
  envelopeAad,
  isSealed,
  openDocument,
  sealDocument,
} from './domain/document-envelope.js';
export { ForensicsPersistenceError } from './domain/forensics.errors.js';
export { MinioObjectStore } from './adapters/minio.object-store.js';
export { MinioObjectWriter } from './adapters/minio.object-writer.js';
export { encodeObjectPath, s3Request } from './adapters/minio.sigv4.js';
export type { S3Reply } from './adapters/minio.sigv4.js';
export { ClamavVirusScanner } from './adapters/clamav.virus-scanner.js';
export { BoundedRealAnalyzer } from './adapters/bounded-real.analyzer.js';
export { PgDocumentRecordStore } from './adapters/document-record.pg-store.js';
export { PgApplicationOwnershipReader } from './adapters/application-ownership.pg-reader.js';
export type { ObjectStore } from './ports/object-store.js';
export { ObjectStoreUnavailableError } from './ports/object-store.js';
export type { ObjectStoreWrite } from './ports/object-store-write.js';
export type {
  ApplicationOwnershipReader,
  OwnedApplication,
  OwnershipQuery,
} from './ports/application-ownership-reader.js';
export type { ScanResult, VirusScanner } from './ports/virus-scanner.js';
export type {
  AnalyzeResult,
  ForensicsAnalyzer,
  ForensicsVerdict,
} from './ports/forensics-analyzer.js';
export type {
  DocumentRecordStore,
  RecordVerdictInput,
  RecordVerdictOutcome,
} from './ports/document-record-store.js';
export { loadDocumentForensicsConfig } from './config.js';
export type {
  DocumentForensicsConfig,
  DocumentIngressConfig,
  ObjectStoreConfig,
  VirusScannerConfig,
} from './config.js';
