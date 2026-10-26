// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA results MAPPING (SDMS format → domain). Pure.
//
// Source shape: tools/g2g-sandbox/contracts/sdms-results-by-index.schema.json
// (captured from rne.sdms.gov.rw, values stripped). Every captured field:
//
//   studentNames            → holder.name (binding only, never stored)
//   gender                  → holder.sex
//   studentNationalIdHint   → holder.nationalIdHint
//   studentIndexNumber      → indexNumber (must equal the one asked for)
//   published, malpractice  → published, malpractice
//   combinationLevelType    → levelType + qualificationLevel:
//                               GENERAL/TVET/TTC → A2 (TVET at A2 counts as
//                               A2: default taken, owner to confirm);
//                               O_LEVEL → O_LEVEL; anything else → null (REVIEW)
//   division                → division (non-PASS → REVIEW, default taken)
//   weightedPercent         → weightedPercent (RCS 4-year science bar)
//   resultsAggregate        → resultsAggregate (may be null; not required)
//   academicYear "YYYY/YYYY"→ examYear (the second year)
//   combination             → combination
//   rawMark[]               → subjects (markPercent, letterGrade,
//                               subject.subjectName, subject.numberOfPeriods);
//                               subject.code and subject.subsidiary are null in
//                               every capture and not mapped
//   studentCode             → not mapped: an internal SDMS key, not needed
//   attendedSchool          → not mapped: never stored or audited (minimisation)
//   placedSchool*, placedCombinationName → not mapped: post-exam placement,
//                               irrelevant to eligibility (null in captures)
// ══════════════════════════════════════════════════════════════════

import type { QualificationLevel } from '@usrp/shared-types';
import type { NesaResults, NesaSubjectMark } from '../domain/nesa.types.js';

export type SdmsMapping =
  | { readonly kind: 'FOUND'; readonly results: NesaResults }
  | { readonly kind: 'FAULT'; readonly reason: string };

const LEVEL_TYPE_TO_QUALIFICATION: Readonly<Record<string, QualificationLevel>> = {
  GENERAL: 'A2',
  TVET: 'A2',
  TTC: 'A2',
  O_LEVEL: 'O_LEVEL',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function mapSdmsResults(body: unknown, askedIndex: string): SdmsMapping {
  if (!isRecord(body)) return { kind: 'FAULT', reason: 'not an object' };
  const index = str(body['studentIndexNumber']);
  const name = str(body['studentNames']);
  if (index === null || name === null || typeof body['published'] !== 'boolean' || typeof body['malpractice'] !== 'boolean' || !Array.isArray(body['rawMark'])) {
    return { kind: 'FAULT', reason: 'results record missing required fields' };
  }
  if (index !== askedIndex) return { kind: 'FAULT', reason: 'answered a different index number' };
  const gender = str(body['gender'])?.toUpperCase() ?? null;
  const levelType = (str(body['combinationLevelType']) ?? '').toUpperCase();
  const year = /^\d{4}\/(\d{4})$/.exec(str(body['academicYear']) ?? '');
  const subjects: NesaSubjectMark[] = [];
  for (const mark of body['rawMark']) {
    if (!isRecord(mark) || !isRecord(mark['subject'])) return { kind: 'FAULT', reason: 'malformed rawMark entry' };
    const markPercent = num(mark['markPercent']);
    const subjectName = str(mark['subject']['subjectName']);
    if (markPercent === null || subjectName === null) return { kind: 'FAULT', reason: 'malformed rawMark entry' };
    subjects.push({ subjectName, markPercent, letterGrade: str(mark['letterGrade']) ?? '', numberOfPeriods: num(mark['subject']['numberOfPeriods']) ?? 0 });
  }
  return {
    kind: 'FOUND',
    results: {
      indexNumber: index,
      holder: { name, sex: gender === 'MALE' || gender === 'FEMALE' ? gender : null, nationalIdHint: str(body['studentNationalIdHint']) },
      published: body['published'],
      malpractice: body['malpractice'],
      levelType,
      qualificationLevel: LEVEL_TYPE_TO_QUALIFICATION[levelType] ?? null,
      division: (str(body['division']) ?? '').toUpperCase(),
      weightedPercent: num(body['weightedPercent']),
      resultsAggregate: num(body['resultsAggregate']),
      examYear: year?.[1] === undefined ? null : Number(year[1]),
      combination: str(body['combination']) ?? '',
      subjects,
    },
  };
}
