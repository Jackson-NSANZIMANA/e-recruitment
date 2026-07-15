// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Bounded-real ForensicsAnalyzer adapter
//
// Today's implementation of the ForensicsAnalyzer port (ADR-011): compose the
// REAL signals we can prove — ClamAV verdict on the actual bytes + the pure
// byte/container/metadata/C2PA-presence probe — into the deterministic
// composeVerdict. Fail-closed: scanner unavailable → SCANNER_UNAVAILABLE,
// never a fabricated lane. The deferred perceptual tier replaces THIS file
// (behind the same port) when its programme lands with a validation plan.
// ══════════════════════════════════════════════════════════════════

import { composeVerdict, probeBytes } from '../domain/forensics.js';
import type { AnalyzeResult, ForensicsAnalyzer } from '../ports/forensics-analyzer.js';
import type { VirusScanner } from '../ports/virus-scanner.js';

export class BoundedRealAnalyzer implements ForensicsAnalyzer {
  readonly #scanner: VirusScanner;

  constructor(scanner: VirusScanner) {
    this.#scanner = scanner;
  }

  async analyze(bytes: Buffer): Promise<AnalyzeResult> {
    const scan = await this.#scanner.scan(bytes);
    if (scan.kind === 'UNAVAILABLE') {
      return { kind: 'SCANNER_UNAVAILABLE', detail: scan.detail };
    }
    const verdict = composeVerdict({
      virusClean: scan.kind === 'CLEAN',
      bytes: probeBytes(bytes),
    });
    return { kind: 'ANALYZED', verdict };
  }
}
