// ══════════════════════════════════════════════════════════════════
// document-forensics-service — VirusScanner port
//
// A REAL malware verdict on real bytes (dev adapter = ClamAV clamd).
// UNAVAILABLE is a distinct outcome, not a throw, because the use case must
// fail CLOSED on it: no scan → no verdict → no lane, never "assume clean".
// ══════════════════════════════════════════════════════════════════

export type ScanResult =
  | { readonly kind: 'CLEAN' }
  | { readonly kind: 'INFECTED'; readonly signature: string }
  | { readonly kind: 'UNAVAILABLE'; readonly detail: string };

export interface VirusScanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}
