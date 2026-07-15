// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Pure forensics domain
//
// Two pure pieces, no I/O, fully deterministic and unit-provable:
//
//   probeBytes(bytes)  — REAL byte-level signals: container identification by
//     magic numbers (PDF/JPEG/PNG — the formats the recruitment announcements
//     accept for scanned certificates), embedded-metadata presence (EXIF/XMP
//     APP1 in JPEG, tEXt/iTXt/eXIf chunks in PNG, /Info | XMP in PDF), and
//     C2PA provenance-manifest PRESENCE (JUMBF APP11 segment in JPEG, caBX/
//     JUMBF box in PDF-embedded or bare form, iTXt c2pa in PNG). Presence ≠
//     cryptographic validity — validating the manifest chain is the deferred
//     tier; today a well-formed manifest marker is a modest positive
//     provenance signal and nothing more.
//
//   composeVerdict(signals) — deterministic score + lane from the real
//     signals. Policy (ADR-011):
//       INFECTED                      → RED, score 0 (malware is dispositive)
//       unknown/unaccepted container  → AMBER (cannot vouch for what we
//                                       cannot even identify)
//       metadata stripped             → deduction (scans straight from a
//                                       scanner/camera carry metadata; a
//                                       stripped file has been through an
//                                       editor or laundering step — weak but
//                                       real signal, never dispositive alone)
//       C2PA manifest present         → boost (opt-in provenance)
//     The four perceptual checks the bounded-real tier cannot perform are
//     null in the flags — "not analyzed", never "checked and clean".
// ══════════════════════════════════════════════════════════════════

import type { DocumentLane, ForensicsFlags } from '@usrp/shared-types';
import type { ForensicsVerdict } from '../ports/forensics-analyzer.js';

export type ContainerFormat = 'PDF' | 'JPEG' | 'PNG' | 'UNKNOWN';

/** Real, byte-derived signals — the analyzer's evidence base. */
export interface ByteSignals {
  readonly container: ContainerFormat;
  readonly hasEmbeddedMetadata: boolean;
  readonly hasC2paManifest: boolean;
}

// ── Container identification (magic numbers) ─────────────────────

const PDF_MAGIC = Buffer.from('%PDF-');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function identifyContainer(bytes: Buffer): ContainerFormat {
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'PDF';
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'PNG';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  return 'UNKNOWN';
}

// ── JPEG segment walk (APP1 = EXIF/XMP, APP11 = JUMBF/C2PA) ───────

interface JpegSignals {
  readonly hasMetadata: boolean;
  readonly hasC2pa: boolean;
}

function walkJpegSegments(bytes: Buffer): JpegSignals {
  let hasMetadata = false;
  let hasC2pa = false;
  let offset = 2; // past SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === undefined) break;
    // Standalone markers (no length): RST0-7, SOI, EOI. Scan stops at SOS —
    // beyond it is entropy-coded image data.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break; // malformed
    const payload = bytes.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe1) {
      // APP1 — EXIF ("Exif\0\0") or XMP (namespace URI prefix)
      if (payload.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ||
          payload.subarray(0, 28).toString('latin1').startsWith('http://ns.adobe.com/xap/1.0/')) {
        hasMetadata = true;
      }
    } else if (marker === 0xeb) {
      // APP11 — JPEG universal metadata box (JUMBF); C2PA rides in it with a
      // "JP" common-identifier prefix per ISO 19566-5 / C2PA spec.
      if (payload.subarray(0, 2).equals(Buffer.from('JP'))) hasC2pa = true;
    }
    offset += 2 + length;
  }
  return { hasMetadata, hasC2pa };
}

// ── PNG chunk walk (tEXt/iTXt/zTXt/eXIf/tIME = metadata) ──────────

interface PngSignals {
  readonly hasMetadata: boolean;
  readonly hasC2pa: boolean;
}

const PNG_METADATA_CHUNKS: ReadonlySet<string> = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);

function walkPngChunks(bytes: Buffer): PngSignals {
  let hasMetadata = false;
  let hasC2pa = false;
  let offset = PNG_MAGIC.length;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    if (PNG_METADATA_CHUNKS.has(type)) hasMetadata = true;
    // C2PA in PNG: a caBX chunk (C2PA spec) or an iTXt carrying a c2pa keyword.
    if (type === 'caBX') hasC2pa = true;
    if (type === 'iTXt' && offset + 8 + Math.min(length, 5) <= bytes.length) {
      if (bytes.subarray(offset + 8, offset + 8 + Math.min(length, 5)).toString('latin1').startsWith('c2pa')) {
        hasC2pa = true;
      }
    }
    if (type === 'IEND') break;
    offset += 12 + length; // length + type + data + CRC
  }
  return { hasMetadata, hasC2pa };
}

// ── PDF text probes ───────────────────────────────────────────────

function probePdf(bytes: Buffer): { hasMetadata: boolean; hasC2pa: boolean } {
  // PDF is a text-structured container; a bounded latin1 view is enough to
  // detect an /Info dictionary or an XMP metadata stream, and a JUMBF/C2PA
  // marker. Bounded to 4 MiB of view — certificates are page-scale documents.
  const view = bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)).toString('latin1');
  const hasMetadata =
    view.includes('/Info') || view.includes('/Metadata') || view.includes('<x:xmpmeta');
  const hasC2pa = view.includes('c2pa') || view.includes('caBX') || view.includes('jumb');
  return { hasMetadata, hasC2pa };
}

// ── The two pure entry points ─────────────────────────────────────

/** Extract real byte-level signals from a document. Total: never throws. */
export function probeBytes(bytes: Buffer): ByteSignals {
  const container = identifyContainer(bytes);
  switch (container) {
    case 'JPEG': {
      const s = walkJpegSegments(bytes);
      return { container, hasEmbeddedMetadata: s.hasMetadata, hasC2paManifest: s.hasC2pa };
    }
    case 'PNG': {
      const s = walkPngChunks(bytes);
      return { container, hasEmbeddedMetadata: s.hasMetadata, hasC2paManifest: s.hasC2pa };
    }
    case 'PDF': {
      const s = probePdf(bytes);
      return { container, hasEmbeddedMetadata: s.hasMetadata, hasC2paManifest: s.hasC2pa };
    }
    case 'UNKNOWN':
      return { container, hasEmbeddedMetadata: false, hasC2paManifest: false };
  }
}

export interface VerdictSignals {
  readonly virusClean: boolean;
  readonly bytes: ByteSignals;
}

const GREEN_THRESHOLD = 70; // score ≥ 70 → GREEN
const AMBER_THRESHOLD = 40; // 40-69 → AMBER, below → RED

/** Compose the deterministic verdict from the real signals. Pure and total. */
export function composeVerdict(signals: VerdictSignals): ForensicsVerdict {
  if (!signals.virusClean) {
    // Malware is dispositive: the document is hostile, not merely suspect.
    return {
      lane: 'RED',
      score: 0,
      flags: makeFlags({ virusClean: false, metadataStripped: false, score: 0 }),
    };
  }

  let score = 100;
  const unknownContainer = signals.bytes.container === 'UNKNOWN';
  const metadataStripped = !unknownContainer && !signals.bytes.hasEmbeddedMetadata;

  if (unknownContainer) score -= 45;      // cannot vouch for an unidentifiable format
  if (metadataStripped) score -= 35;      // laundered/re-encoded — review, don't trust blind
  if (signals.bytes.hasC2paManifest) score = Math.min(100, score + 10); // opt-in provenance

  const lane: DocumentLane = score >= GREEN_THRESHOLD ? 'GREEN' : score >= AMBER_THRESHOLD ? 'AMBER' : 'RED';
  return { lane, score, flags: makeFlags({ virusClean: true, metadataStripped, score }) };
}

function makeFlags(input: {
  virusClean: boolean;
  metadataStripped: boolean;
  score: number;
}): ForensicsFlags {
  return {
    // Deferred perceptual tier — not analyzed, and the contract says so.
    elaAnomalyDetected: null,
    fontMismatchDetected: null,
    stampCloneDetected: null,
    ganGeneratedDetected: null,
    // Presence detection only today; cryptographic manifest validation is the
    // deferred tier, so no validity verdict is ever asserted here.
    c2paManifestValid: null,
    virusScanClean: input.virusClean,
    metadataStripped: input.metadataStripped,
    overallScore: input.score,
  };
}
