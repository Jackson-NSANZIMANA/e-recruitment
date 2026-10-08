// BUILD-001 P1–P4 domain proofs: structural validation, policy normalization,
// canonical serialization, and deterministic coverage hashing. No DB required.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KAFKA_TOPICS } from '@usrp/shared-types';
import {
  campaignCoverageHash,
  canonicalCampaignJson,
  hashCampaignCanonicalJson,
} from '@usrp/shared-security';
import {
  normalizeCampaignDraft,
  normalizeCampaignPolicy,
  normalizeCampaignSession,
} from '../src/domain/campaign-validation.js';
import { hashCampaignPolicy } from '../src/domain/campaign-policy.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function expectThrow(label: string, run: () => unknown, pattern?: RegExp): void {
  try {
    run();
    check(label, false, 'expected validation to reject the input');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, pattern === undefined || pattern.test(message), message);
  }
}

// Values below are synthetic validation fixtures only. They are not claimed to
// be official Rwandan recruitment policy or thresholds.
const draftInput = {
  publicCode: 'rdf-selfcheck-2030',
  campaignLabel: 'BUILD-001 domain proof',
  targetCategories: ['GENERAL_ENLISTMENT'],
  targetDistricts: ['KICUKIRO', 'GASABO'],
  registrationOpensAt: '2030-01-01T08:00:00+02:00',
  registrationClosesAt: '2030-01-31T17:00:00+02:00',
  examinationStartDate: '2030-02-01',
  examinationEndDate: '2030-02-15',
  examinationReportingHour: 8,
  allowsWalkIn: false,
};
const policyInput = {
  publicCode: 'RDF-SELFCHECK-2030',
  legalBasisCode: 'SELF_CHECK_FIXTURE',
  legalBasisReference: 'Synthetic fixture only; not an official legal reference.',
  policyDocument: {
    GENERAL_ENLISTMENT: {
      age: { minimumAge: 18, maximumAge: 29, referenceDate: '2030-01-01' },
      education: { mode: 'SELF_CHECK_MODE', threshold: 'SELF_CHECK_THRESHOLD' },
      criminalThreshold: 'SELF_CHECK_CRIMINAL_RULE',
      requiredDocumentTypes: ['GOOD_CONDUCT_CERTIFICATE', 'NATIONAL_ID'],
      medicalMode: 'SELF_CHECK_MEDICAL_RULE',
      legalBasis: { code: 'SELF_CHECK_FIXTURE', reference: 'Synthetic fixture only.' },
    },
  },
};
const sessionInput = {
  publicCode: 'RDF-SELFCHECK-2030',
  district: 'GASABO',
  province: 'KIGALI_CITY',
  venueName: 'Café Test Hall',
  examDate: '2030-02-03',
  reportingTimeHour: 8,
  capacityLimit: 100,
  isActive: true,
};

function main(): void {
  console.log('\n── P1. Draft input is normalized and agency-bound ────────────');
  const draft = normalizeCampaignDraft(draftInput, 'RDF');
  check('publicCode normalized to uppercase', draft.publicCode === 'RDF-SELFCHECK-2030');
  check('target districts sorted canonically', draft.targetDistricts.join(',') === 'GASABO,KICUKIRO');
  check('target category retained', draft.targetCategories[0] === 'GENERAL_ENLISTMENT');
  expectThrow('unknown draft fields rejected', () => normalizeCampaignDraft({ ...draftInput, agency: 'RDF' }, 'RDF'));
  expectThrow('cross-agency target category rejected', () => normalizeCampaignDraft({
    ...draftInput,
    targetCategories: ['CADET_OFFICER'],
  }, 'RDF'));

  console.log('\n── P2. Policy shape, coverage, and canonical SHA-256 ──────────');
  const policy = normalizeCampaignPolicy(policyInput, ['GENERAL_ENLISTMENT']);
  const digest = hashCampaignPolicy(policy);
  check('policy hash is lowercase SHA-256 hex', /^[0-9a-f]{64}$/.test(digest));
  check('policy required-document set is sorted', policy.policyDocument['GENERAL_ENLISTMENT']?.requiredDocumentTypes.join(',') === 'GOOD_CONDUCT_CERTIFICATE,NATIONAL_ID');
  check('policy hash is independent of source object key order', hashCampaignPolicy(normalizeCampaignPolicy({
    publicCode: policyInput.publicCode,
    legalBasisCode: policyInput.legalBasisCode,
    legalBasisReference: policyInput.legalBasisReference,
    policyDocument: {
      GENERAL_ENLISTMENT: {
        medicalMode: 'SELF_CHECK_MEDICAL_RULE',
        legalBasis: { reference: 'Synthetic fixture only.', code: 'SELF_CHECK_FIXTURE' },
        requiredDocumentTypes: ['NATIONAL_ID', 'GOOD_CONDUCT_CERTIFICATE'],
        criminalThreshold: 'SELF_CHECK_CRIMINAL_RULE',
        education: { threshold: 'SELF_CHECK_THRESHOLD', mode: 'SELF_CHECK_MODE' },
        age: { referenceDate: '2030-01-01', maximumAge: 29, minimumAge: 18 },
      },
    },
  }, ['GENERAL_ENLISTMENT'])) === digest);
  expectThrow('policy must cover exactly the targeted categories', () => normalizeCampaignPolicy(policyInput, ['CADET_OFFICER']));
  expectThrow('incomplete policy category rejected', () => normalizeCampaignPolicy({
    ...policyInput,
    policyDocument: { GENERAL_ENLISTMENT: { age: { minimumAge: 18 } } },
  }, ['GENERAL_ENLISTMENT']));
  expectThrow('reversed age range rejected', () => normalizeCampaignPolicy({
    ...policyInput,
    policyDocument: {
      GENERAL_ENLISTMENT: {
        ...policyInput.policyDocument.GENERAL_ENLISTMENT,
        age: { minimumAge: 30, maximumAge: 18, referenceDate: '2030-01-01' },
      },
    },
  }, ['GENERAL_ENLISTMENT']));

  console.log('\n── P3. Canonical JSON v1 byte contract ───────────────────────');
  const canonical = canonicalCampaignJson({ z: 'e\u0301', a: [2, -0, null] });
  check('NFC, object-key order, compact JSON, array order, null, and negative zero', canonical === '{"a":[2,0,null],"z":"é"}', canonical);
  const expectedDigest = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  check('digest hashes UTF-8 canonical bytes as lowercase hex', hashCampaignCanonicalJson({ z: 'é', a: [2, 0, null] }) === expectedDigest);
  check('array order is preserved', canonicalCampaignJson([1, 2]) !== canonicalCampaignJson([2, 1]));
  check('integer-looking object keys use UTF-16 lexical order',
    canonicalCampaignJson({ '2': 'two', '10': 'ten' }) === '{"10":"ten","2":"two"}');
  expectThrow('undefined object values rejected', () => canonicalCampaignJson({ missing: undefined }));
  expectThrow('accessor properties rejected', () => canonicalCampaignJson(Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => 1,
  })));
  const sparse: unknown[] = [];
  sparse.length = 1;
  expectThrow('sparse array entries rejected', () => canonicalCampaignJson(sparse));
  expectThrow('arrays with custom own properties rejected', () => canonicalCampaignJson(Object.assign([1], { extra: true })));
  expectThrow('arrays with nonstandard prototypes rejected', () => canonicalCampaignJson(Object.setPrototypeOf([1], {})));
  expectThrow('NFC-colliding object keys rejected', () => canonicalCampaignJson({ 'é': 1, 'e\u0301': 2 }));

  console.log('\n── P4. Session validation and versioned coverage hash ─────────');
  const session = normalizeCampaignSession(sessionInput);
  check('venue name is NFC normalized', session.venueName === 'Café Test Hall');
  check('district/province relationship validated', session.district === 'GASABO' && session.province === 'KIGALI_CITY');
  expectThrow('zero session capacity rejected', () => normalizeCampaignSession({ ...sessionInput, capacityLimit: 0 }));
  expectThrow('district/province mismatch rejected', () => normalizeCampaignSession({ ...sessionInput, province: 'EASTERN' }));
  const secondSession = {
    ...session,
    district: 'KICUKIRO' as const,
    venueName: 'Other Test Hall',
  };
  const hash = campaignCoverageHash('11111111-1111-4111-8111-111111111111', [session, secondSession]);
  check('coverage hash is lowercase SHA-256 hex', /^[0-9a-f]{64}$/.test(hash));
  check('coverage hash is independent of input session order', campaignCoverageHash(
    '11111111-1111-4111-8111-111111111111',
    [secondSession, session],
  ) === hash);
  check('coverage hash is NFC-stable for venue names', campaignCoverageHash(
    '11111111-1111-4111-8111-111111111111',
    [{ ...session, venueName: 'Cafe\u0301 Test Hall' }, secondSession],
  ) === hash);
  check('coverage hash changes when capacity changes', campaignCoverageHash(
    '11111111-1111-4111-8111-111111111111',
    [{ ...session, capacityLimit: 101 }, secondSession],
  ) !== hash);

  const kafkaCompose = readFileSync(
    new URL('../../../infrastructure/docker/docker-compose.tier2.yml', import.meta.url),
    'utf8',
  );
  const provisionedTopicSpec = kafkaCompose.match(/for spec in ([^\n]+); do/)?.[1] ?? '';
  check(
    'campaign lifecycle topic is provisioned with Kafka auto-creation disabled',
    kafkaCompose.includes('KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"') &&
      provisionedTopicSpec.split(/\s+/).includes(`${KAFKA_TOPICS.CAMPAIGN_LIFECYCLE}:6`),
  );

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('BUILD-001 DOMAIN PROOFS P1–P4 PASSED ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main();
if (failures !== 0) process.exitCode = 1;
