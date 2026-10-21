// Permission model proof — pure, no infrastructure.
import assert from 'node:assert/strict';
import {
  ALL_PERMISSIONS,
  KNOWN_ROLES,
  OFFICER_ADMIN_PERMISSION_LIST,
  hasCampaignPermission,
  permissionsForRoles,
  principalHasPermission,
  rolesHavePermission,
  type Principal,
} from '../src/index.js';

let n = 0;
const ok = (label: string, cond: boolean): void => {
  assert.ok(cond, label);
  n += 1;
  console.log(`  ✓ ${label}`);
};

const officer = (roles: string[]): Principal => ({
  kind: 'officer',
  subjectId: '11111111-1111-4111-8111-111111111111',
  agency: 'RDF',
  roles,
});

console.log('\n── Fail closed ──');
ok('no roles grant nothing', ALL_PERMISSIONS.every((p) => !rolesHavePermission([], p)));
ok('an unknown role grants nothing', ALL_PERMISSIONS.every((p) => !rolesHavePermission(['superadmin', 'root', '*'], p)));
ok('Object.prototype names are not roles', !rolesHavePermission(['constructor', 'toString', '__proto__'], 'decision.final'));
ok('a system principal holds no human permission', !principalHasPermission({ kind: 'system', subjectId: 'x' }, 'application.read'));
ok('campaign.read.public is never conferred to an officer', !rolesHavePermission([...KNOWN_ROLES], 'campaign.read.public'));

console.log('\n── No dead permission, no god role ──');
for (const p of ALL_PERMISSIONS) {
  if (p === 'campaign.read.public') continue;
  ok(`${p} is granted by at least one role`, KNOWN_ROLES.some((r) => rolesHavePermission([r], p)));
}
ok('no single role holds every non-public permission',
  KNOWN_ROLES.every((r) => ALL_PERMISSIONS.filter((p) => p !== 'campaign.read.public').some((p) => !rolesHavePermission([r], p))));

console.log('\n── Separation by construction ──');
ok('medical.review and decision.final never live in one role',
  KNOWN_ROLES.every((r) => !(rolesHavePermission([r], 'medical.review') && rolesHavePermission([r], 'decision.final'))));
ok('the campaign admin cannot decide a candidate',
  !rolesHavePermission(['agency_admin'], 'decision.final') &&
  !rolesHavePermission(['agency_admin'], 'medical.review') &&
  !rolesHavePermission(['agency_admin'], 'application.accept'));
ok('a reviewer can read but not mutate', 
  rolesHavePermission(['reviewer'], 'application.read') &&
  permissionsForRoles(['reviewer']).every((p) => p === 'application.read' || p === 'adjudication.read' || p === 'campaign.read.admin' || p === 'biometric.evidence.read'));
ok('only decision_authority finalises and accepts',
  KNOWN_ROLES.filter((r) => rolesHavePermission([r], 'decision.final')).join() === 'decision_authority' &&
  KNOWN_ROLES.filter((r) => rolesHavePermission([r], 'application.accept')).join() === 'decision_authority');
ok('the screening officer cannot resolve conflicts (authority over evidence)', !rolesHavePermission(['screening_officer'], 'field.conflict.resolve'));
ok('only the front-door check-in post clears documents at the venue (owner decision 2026-10-14)',
  KNOWN_ROLES.filter((r) => rolesHavePermission([r], 'document.verify.venue')).join() === 'screening_officer');
ok('only the front-door check-in post admits at the gate (BUILD-003, ADR-034)',
  KNOWN_ROLES.filter((r) => rolesHavePermission([r], 'admission.gate')).join() === 'screening_officer');
ok('the gate post cannot decide, accept or review medically (the gate is not a decision)',
  !rolesHavePermission(['screening_officer'], 'decision.final') &&
  !rolesHavePermission(['screening_officer'], 'application.accept') &&
  !rolesHavePermission(['screening_officer'], 'medical.review'));
ok('the DPO sees no applications', !rolesHavePermission(['dpo'], 'application.read'));
ok('only agency_admin administers officers (ADR-036)',
  OFFICER_ADMIN_PERMISSION_LIST.every((p) => KNOWN_ROLES.filter((r) => rolesHavePermission([r], p)).join() === 'agency_admin'));
ok('officer administration confers no decision power by itself (ADR-036)',
  !rolesHavePermission(['agency_admin'], 'decision.final') && !rolesHavePermission(['agency_admin'], 'medical.review') &&
  !rolesHavePermission(['agency_admin'], 'adjudication.decide') && !rolesHavePermission(['agency_admin'], 'admission.gate'));

ok('only field_supervisor confirms manual identity after negative biometric evidence (ADR-037)',
  KNOWN_ROLES.filter((r) => rolesHavePermission([r], 'identity.manual.confirm')).join() === 'field_supervisor');
ok('the gate post records evidence but cannot confirm identity or read evidence (ADR-037)',
  rolesHavePermission(['screening_officer'], 'biometric.verify') &&
  !rolesHavePermission(['screening_officer'], 'identity.manual.confirm') &&
  !rolesHavePermission(['screening_officer'], 'biometric.evidence.read'));
ok('advisory evidence is read by reviewers, supervisors, adjudicators and decision authorities (ADR-037)',
  KNOWN_ROLES.filter((r) => rolesHavePermission([r], 'biometric.evidence.read')).sort().join() ===
    'adjudicator,decision_authority,field_supervisor,reviewer');

console.log('\n── Composition and compatibility ──');
ok('roles compose (union)', rolesHavePermission(['medical_officer', 'adjudicator'], 'medical.review') && rolesHavePermission(['medical_officer', 'adjudicator'], 'adjudication.decide'));
ok('BUILD-001 helper agrees with the table', hasCampaignPermission(officer(['agency_admin']), 'campaign.publish') && !hasCampaignPermission(officer(['reviewer']), 'campaign.publish'));

console.log(`\nPERMISSION MODEL GREEN — ${String(n)} assertions ✓`);
