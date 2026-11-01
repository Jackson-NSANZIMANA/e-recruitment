// ══════════════════════════════════════════════════════════════════
// shared-types — DOCUMENT DOOR CONTRACT PROOF (zero infrastructure)
//
// D7 was not "a wrong string". document-forensics-service and
// identity-service each carried their own hand-written idea of what the door
// can answer; they disagreed; a caller error reached the citizen as
// "503 UPSTREAM_UNAVAILABLE — try again later". Nothing failed when they
// drifted, so the drift was found by a human reading an evaluation.
//
// This proof makes that class of drift a red gate. It asserts FOUR things:
//
//   1. AGREEMENT IN BOTH DIRECTIONS between the one shared table and the code
//      that renders (forensics) and classifies (identity) it: every code a
//      service can answer with is declared, and no declared code is unreachable
//      from the service that owns it.
//   2. THE CITIZEN'S EXPERIENCE, behaviourally: a document-type refusal is a
//      422 refusal, a scanner outage is a truthful 503, and an UNCLASSIFIABLE
//      4xx is a refusal with loud drift — never "unavailable".
//   3. ONE SOURCE for the agency document sets (no third hand-written copy).
//   4. NO HAND-WRITTEN RELAY TABLE left in identity-service.
//
// It opens no socket and touches no database, so it runs at the front of the
// gate beside verify-edge-contract.ts.
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCUMENT_DOOR_CODES,
  DOCUMENT_DOOR_RELAY,
  classifyDocumentDoorAnswer,
  isDocumentDoorCode,
  statusForDocumentDoorCode,
  actorForDocumentDoorCode,
  isKnownDocumentType,
  AGENCY_DOCUMENT_TYPES,
  type DocumentDoorCode,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const FORENSICS_CONTROLLER = join(
  REPO,
  'services/document-forensics-service/src/adapters/http/upload-document.controller.ts',
);
const IDENTITY_GATEWAY = join(
  REPO,
  'services/identity-service/src/adapters/document-upload.http-gateway.ts',
);
const IDENTITY_CONTROLLER = join(
  REPO,
  'services/identity-service/src/adapters/http/applicant-documents.controller.ts',
);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}
function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

/** Every `'CODE'` literal passed to a named helper, e.g. doorResult('FILE_TOO_LARGE'). */
function codesPassedTo(source: string, helper: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`${helper}\\(\\s*'([A-Z_]+)'`, 'g');
  for (const match of source.matchAll(re)) {
    if (match[1] !== undefined) out.add(match[1]);
  }
  return out;
}

/** Every literal first argument of `new HttpError(status, 'CODE'` in a source. */
function literalHttpErrorCodes(source: string): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(/new HttpError\(\s*\d+\s*,\s*'([A-Z_]+)'/g)) {
    if (match[1] !== undefined) out.add(match[1]);
  }
  return out;
}

const declared = Object.keys(DOCUMENT_DOOR_CODES) as DocumentDoorCode[];
const forensics = readFileSync(FORENSICS_CONTROLLER, 'utf8');
const gateway = readFileSync(IDENTITY_GATEWAY, 'utf8');
const identity = readFileSync(IDENTITY_CONTROLLER, 'utf8');

// ── 1. The table itself is complete and meaningful ─────────────────
section('The shared vocabulary is total and meaningful');
check(
  'every code declares a status and an actor',
  declared.every((code) => {
    const spec = DOCUMENT_DOOR_CODES[code];
    return Number.isInteger(spec.status) && spec.status >= 100 && spec.status <= 599 && spec.actor !== undefined;
  }),
);
check(
  'no code answers a 2xx except UPLOADED',
  declared.filter((code) => DOCUMENT_DOOR_CODES[code].status < 300).join(',') === 'UPLOADED',
  declared.filter((code) => DOCUMENT_DOOR_CODES[code].status < 300).join(','),
);
check(
  'every SYSTEM code answers 5xx and every CALLER/UPLOADER code answers 4xx',
  declared.every((code) => {
    const { status, actor } = DOCUMENT_DOOR_CODES[code];
    if (code === 'UPLOADED') return true;
    return actor === 'SYSTEM' ? status >= 500 : status >= 400 && status < 500;
  }),
);
check(
  'an unknown string is not a code',
  !isDocumentDoorCode('NOT_A_REAL_CODE') && statusForDocumentDoorCode('NOT_A_REAL_CODE') === undefined,
);

// ── 2. Producer ↔ table, both directions ───────────────────────────
section('Forensics renders from the table; the table describes forensics');
const produced = new Set<string>([
  ...codesPassedTo(forensics, 'doorResult'),
  ...codesPassedTo(forensics, 'documentDoorError'),
]);
check(
  'the forensics door names at least one code through the shared helper',
  produced.size > 0,
  `${String(produced.size)} found`,
);
const undeclared = [...produced].filter((code) => !isDocumentDoorCode(code));
check('every code forensics can answer with is declared', undeclared.length === 0, undeclared.join(', '));

const strayLiterals = literalHttpErrorCodes(forensics);
check(
  'forensics has no `new HttpError(status, "CODE")` left (status must come from the table)',
  strayLiterals.size === 0,
  [...strayLiterals].join(', '),
);

// The door's own vocabulary: everything it refuses or reports, by name.
const DOOR_MUST_ANSWER: readonly DocumentDoorCode[] = [
  'INVALID_REQUEST',
  'INVALID_FILENAME',
  'MISSING_FILE',
  'EMPTY_FILE',
  'INVALID_DOCUMENT_TYPE',
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'APPLICATION_NOT_FOUND',
  'NOT_ACCEPTING_DOCUMENTS',
  'UNSUPPORTED_DOCUMENT_TYPE',
  'UNSUPPORTED_FILE_CONTENT',
  'CONTENT_TYPE_MISMATCH',
  'DOCUMENT_REJECTED_MALWARE',
  'SCANNER_UNAVAILABLE',
  'OBJECT_STORE_UNAVAILABLE',
  'DOCUMENT_ENCRYPTION_ERROR',
  'FORENSICS_PERSISTENCE_ERROR',
  'INTERNAL_ERROR',
];
const unreachable = DOOR_MUST_ANSWER.filter((code) => !produced.has(code));
check(
  'every answer the door is expected to give is produced by its controller',
  unreachable.length === 0,
  unreachable.join(', '),
);

// ── 3. Consumer ↔ table, both directions ───────────────────────────
section('Identity classifies from the table; the table describes identity');
check(
  'identity-classification is the shared pure function, not a local Set',
  gateway.includes('classifyDocumentDoorAnswer('),
);
check(
  'the hand-written REFUSALS set is gone',
  !gateway.includes('REFUSALS') && !/ReadonlySet<string>/.test(gateway),
);
const relayed = Object.keys(DOCUMENT_DOOR_RELAY) as DocumentDoorCode[];
const relayUndeclared = relayed.filter((code) => !isDocumentDoorCode(code));
check('every relayed code is declared', relayUndeclared.length === 0, relayUndeclared.join(', '));
const relayTargetsUndeclared = relayed.filter((code) => {
  const target = DOCUMENT_DOOR_RELAY[code];
  return target !== undefined && !isDocumentDoorCode(target.as);
});
check(
  'every relay target is a declared code',
  relayTargetsUndeclared.length === 0,
  relayTargetsUndeclared.join(', '),
);
check(
  'nothing is relayed as "unavailable" (the D7 trap)',
  relayed.every((code) => DOCUMENT_DOOR_RELAY[code]?.as !== 'DEPENDENCY_UNAVAILABLE'),
);
check(
  'the one 4xx code that means "refused, reason unknown" exists and is a refusal',
  DOCUMENT_DOOR_CODES.DOCUMENT_REFUSED.actor === 'UPLOADER' && DOCUMENT_DOOR_CODES.DOCUMENT_REFUSED.status === 422,
);

// ── 4. The citizen's experience, behaviourally ─────────────────────
section('What the citizen is told (the behaviour D7 broke)');
const invalidType = classifyDocumentDoorAnswer(
  DOCUMENT_DOOR_CODES.INVALID_DOCUMENT_TYPE.status,
  'INVALID_DOCUMENT_TYPE',
);
check(
  'an invalid document type is a 422 refusal, never "unavailable"',
  invalidType.kind === 'RELAY' && invalidType.status === 422 && invalidType.code === 'UNSUPPORTED_DOCUMENT_TYPE',
  JSON.stringify(invalidType),
);

const scannerDown = classifyDocumentDoorAnswer(
  DOCUMENT_DOOR_CODES.SCANNER_UNAVAILABLE.status,
  'SCANNER_UNAVAILABLE',
);
check(
  'a scanner outage keeps its own truthful 503 code',
  scannerDown.kind === 'RELAY' && scannerDown.status === 503 && scannerDown.code === 'SCANNER_UNAVAILABLE',
  JSON.stringify(scannerDown),
);

const unknownRefusal = classifyDocumentDoorAnswer(400, 'SOME_FUTURE_CODE');
check(
  'an unclassifiable 4xx is a refusal (DOCUMENT_REFUSED), not an outage',
  unknownRefusal.kind === 'RELAY' && unknownRefusal.code === 'DOCUMENT_REFUSED' && unknownRefusal.status === 422,
  JSON.stringify(unknownRefusal),
);

const unknownRefusalNoBody = classifyDocumentDoorAnswer(409, undefined);
check(
  'an unclassifiable 4xx with no body is still a refusal',
  unknownRefusalNoBody.kind === 'RELAY' && unknownRefusalNoBody.code === 'DOCUMENT_REFUSED',
  JSON.stringify(unknownRefusalNoBody),
);

const serverFault = classifyDocumentDoorAnswer(500, 'SOMETHING_INTERNAL');
check(
  'a 5xx that we cannot name is a dependency failure (retrying is honest there)',
  serverFault.kind === 'DEPENDENCY_UNAVAILABLE',
  JSON.stringify(serverFault),
);

const accepted = classifyDocumentDoorAnswer(201, 'UPLOADED');
check('a 201 is an upload', accepted.kind === 'UPLOADED');

// ── 5. One source for the agency document sets ─────────────────────
section('The agency document sets have one definition');
check(
  'isKnownDocumentType accepts a real type and refuses a word',
  isKnownDocumentType('NATIONAL_ID') && !isKnownDocumentType('BIRTHDAY_CARD'),
);
check(
  'every agency set is non-empty and contains NATIONAL_ID',
  ['RDF', 'RNP', 'RCS'].every((agency) => {
    const set = AGENCY_DOCUMENT_TYPES[agency as 'RDF' | 'RNP' | 'RCS'];
    return set.size > 0 && set.has('NATIONAL_ID');
  }),
);
check(
  'identity pre-validates the type before spending a round trip',
  identity.includes('isKnownDocumentType('),
);
check(
  'identity no longer retypes a document-type allowlist',
  !identity.includes('KNOWN_DOCUMENT_TYPES.has(') && !/DOCUMENT_TYPES\s*=\s*new Set/.test(identity),
);

// ── Verdict ────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) {
  console.error(`\nDOCUMENT DOOR CONTRACT FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\u001b[0;32mDOCUMENT DOOR CONTRACT OK\u001b[0m');
