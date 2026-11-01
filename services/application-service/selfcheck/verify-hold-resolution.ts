// ══════════════════════════════════════════════════════════════════
// verify-hold-resolution — D10 reconciled (zero infrastructure)
//
// ONE verb resolves a held vetting dimension: `adjudicate` with a `lane`
// (shipped by #58). What this proof pins is what the reconciliation ADDED to it:
//
//   • every officer who resolves a CRIMINAL or ACADEMIC hold is recorded on the
//     row (a SET, in all three schemas) — so four eyes survives a row that two
//     officers resolved;
//   • the accept transaction refuses any member of that set;
//   • a machine verdict that arrives after a human decision changes nothing;
//   • there is no second verb: no vetting-hold route, permission or operation.
//
// The live legs (a real transaction, the loser of a race) are the owner's
// `pnpm selfcheck` on infrastructure; the SQL is asserted structurally here.
// ══════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decidedByHuman } from '../src/domain/human-decision.js';
import { adjudicationLanes } from '../src/domain/adjudication-lanes.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean): void {
  if (ok) { pass += 1; console.log(`\u001b[0;32m  ✓ ${label}\u001b[0m`); }
  else { fail += 1; failures.push(label); console.error(`\u001b[0;31m  ✗ ${label}\u001b[0m`); }
}
const section = (t: string): void => console.log(`\n\u001b[1;36m══ ${t}\u001b[0m`);

section('a human decision outranks a machine verdict (pure)');
check('nothing resolved → a machine verdict applies', !decidedByHuman([], 'CRIMINAL'));
check('criminal resolved → a late criminal verdict is refused', decidedByHuman(['CRIMINAL'], 'CRIMINAL'));
check('criminal resolved → the ACADEMIC dimension is still the machine\'s', !decidedByHuman(['CRIMINAL'], 'ACADEMIC'));
check('both resolved → both are refused', decidedByHuman(['CRIMINAL', 'ACADEMIC'], 'ACADEMIC'));
check('AGE is never a held dimension, so it is never refused', !decidedByHuman(['CRIMINAL', 'ACADEMIC'], 'AGE'));

section('the queue and the verb share one predicate');
const lanes = adjudicationLanes({ status: 'CRIMINAL_CLEARANCE', criminalStatus: 'UNDER_REVIEW', academicStatus: 'PENDING', academicDetail: { failureCode: 'NESA_REVIEW_REQUIRED' } });
check('a criminal UNDER_REVIEW and a NESA review are both lanes', lanes.includes('CRIMINAL') && lanes.includes('ACADEMIC'));
check('a resolved row (terminal) holds nothing', adjudicationLanes({ status: 'REJECTED', criminalStatus: 'UNDER_REVIEW', academicStatus: 'PENDING', academicDetail: null }).length === 0);

section('the resolver set is durable, in all three schemas');
const migration = read('packages/shared-database/src/rls/0047_vetting_hold_resolution.sql');
check('one migration covers rdf_ops, rnp_ops and rcs_ops', /ARRAY\['rdf_ops', 'rnp_ops', 'rcs_ops'\]/.test(migration));
check('resolvers and dimensions are arrays, not a last-writer-wins slot', /vetting_hold_resolvers uuid\[\]/.test(migration) && /vetting_hold_resolved_dimensions text\[\]/.test(migration));
for (const a of ['rdf', 'rnp', 'rcs']) {
  const schema = read(`packages/shared-database/src/schemas/${a}-ops.schema.ts`);
  check(`${a}_ops declares both columns`, /vetting_hold_resolvers/.test(schema) && /vetting_hold_resolved_dimensions/.test(schema));
}
check('bootstrap applies the migration', /0047_vetting_hold_resolution\.sql/.test(read('scripts/bootstrap-db.sh')));

section('adjudicate stamps the resolver; accept refuses any resolver');
const repo = read('services/application-service/src/adapters/officer-transition.pg-repository.ts');
check('the CRIMINAL lane stamps the resolver', /stampResolution\(actor\.officerId, 'CRIMINAL'\)/.test(repo));
check('the ACADEMIC lane stamps the resolver', /stampResolution\(actor\.officerId, 'ACADEMIC'\)/.test(repo));
check('the stamp is idempotent (a repeat adds nothing)', /= ANY\(vetting_hold_resolvers\)[\s\S]{0,200}THEN vetting_hold_resolvers/.test(repo));
check('accept reads the SET under the row lock and refuses a member', /vetting_hold_resolvers\.includes\(actor\.officerId\)/.test(repo) && /ACCEPT_EXCLUDES_CLEARANCE_REVIEWER/.test(repo));
check('the four-eyes read precedes the cross-agency lock', repo.indexOf('ACCEPT_EXCLUDES_CLEARANCE_REVIEWER') < repo.indexOf('Cross-agency accept-lock'));
check('the policy is ON by default', /clearanceReviewExcludesAccepter: true/.test(repo) && /SOD_CLEARANCE_REVIEW_EXCLUDES_ACCEPTER: withDefault\(boolean\(\), true\)/.test(read('services/application-service/src/config.ts')));

section('the projection never lets a machine overwrite the decision');
const projection = read('services/application-service/src/adapters/application.pg-repository.ts');
check('the guard reads the resolved dimensions under FOR UPDATE', /vetting_hold_resolved_dimensions\s+FROM [\s\S]{0,40}applications\s+WHERE id = \$\{result\.applicationId\}\s+FOR UPDATE/.test(projection));
check('a decided dimension returns NO_CHANGE before any write', projection.indexOf('decidedByHuman(') < projection.indexOf('UPDATE ${schema}.applications SET'));

section('there is exactly ONE hold verb');
const surface = [
  'services/edge-gateway/src/domain/edge-operations.ts',
  'services/edge-gateway/src/domain/upstream-operations.ts',
  'services/edge-gateway/src/routes.ts',
  'services/edge-gateway/openapi/edge-v1.yaml',
  'packages/shared-auth/src/permissions.ts',
  'services/application-service/src/adapters/http/officer-transitions.controller.ts',
].map(read).join('\n');
check('no vetting-hold route, operation or permission exists', !/vetting-hold|resolveVettingHold|vetting\.hold\.resolve/.test(surface));
check('adjudicate still carries `lane` end to end', /lane/.test(read('services/edge-gateway/src/adapters/http/officer-transitions.controller.ts')) && /ADJUDICATION_LANES/.test(read('services/application-service/src/adapters/http/officer-transitions.controller.ts')));

console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) { console.error(`\nHOLD RESOLUTION FAILED: ${failures.join(' | ')}`); process.exit(1); }
console.log('\u001b[0;32mHOLD RESOLUTION OK\u001b[0m');
