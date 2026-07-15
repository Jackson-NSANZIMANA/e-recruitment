// ══════════════════════════════════════════════════════════════════
// @usrp/document-forensics-service — Public API & composition root
//
// Wires the hexagonal core (AnalyzeDocumentService) to its real adapters:
// MinIO retrieval (hand-rolled SigV4 GET), the bounded-real analyzer (ClamAV
// + pure byte probe), and the PostgreSQL document_records store. The caller
// supplies the EventBus (InMemory in proofs, Kafka in production) — the use
// case never knows which. Transport is composed in main.ts.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { MinioObjectStore } from './adapters/minio.object-store.js';
import { ClamavVirusScanner } from './adapters/clamav.virus-scanner.js';
import { BoundedRealAnalyzer } from './adapters/bounded-real.analyzer.js';
import { PgDocumentRecordStore } from './adapters/document-record.pg-store.js';
import { AnalyzeDocumentService } from './application/analyze-document.service.js';
import type { DocumentForensicsConfig } from './config.js';

export interface DocumentForensicsService {
  /** HTTP ingress — analyze a referenced document (POST /v1/forensics/analyze). */
  readonly analyzeDocument: AnalyzeDocumentService;
}

export function createDocumentForensicsService(
  config: DocumentForensicsConfig,
  eventBus: EventBus,
): DocumentForensicsService {
  const objectStore = new MinioObjectStore(config.objectStore);
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
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export {
  ANALYZE_DOCUMENT_PATH,
  analyzeDocumentRoute,
} from './adapters/http/analyze-document.controller.js';
export { AnalyzeDocumentService } from './application/analyze-document.service.js';
export type {
  AnalyzeDocumentCommand,
  AnalyzeDocumentDeps,
  AnalyzeDocumentOutcome,
} from './application/analyze-document.service.js';
export { composeVerdict, probeBytes } from './domain/forensics.js';
export type { ByteSignals, ContainerFormat, VerdictSignals } from './domain/forensics.js';
export { AGENCY_DOCUMENT_TYPES, isDocumentTypeSupported } from './domain/agency-documents.js';
export { ForensicsPersistenceError } from './domain/forensics.errors.js';
export { MinioObjectStore } from './adapters/minio.object-store.js';
export { ClamavVirusScanner } from './adapters/clamav.virus-scanner.js';
export { BoundedRealAnalyzer } from './adapters/bounded-real.analyzer.js';
export { PgDocumentRecordStore } from './adapters/document-record.pg-store.js';
export type { ObjectStore } from './ports/object-store.js';
export { ObjectStoreUnavailableError } from './ports/object-store.js';
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
  ObjectStoreConfig,
  VirusScannerConfig,
} from './config.js';
