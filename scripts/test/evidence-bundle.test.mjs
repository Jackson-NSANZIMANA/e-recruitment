import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJUnit, parseProofLog } from '../evidence-bundle.mjs';

const GREEN = '\x1b[0;32m';
const RESET = '\x1b[0m';

test('a clean run is passed, with counts from the summary line', () => {
  const log = `${GREEN}✓ PASS — a${RESET}\n${GREEN}✓ PASS — b${RESET}\nProofs: ${GREEN}2 passed${RESET}, ${GREEN}0 failed${RESET}\n`;
  assert.deepEqual(parseProofLog(log), { status: 'passed', passed: 2, skipped: 0, failed: 0, skippedChecks: [], failedChecks: [] });
});

test('a skipped check is named and the run is not reported as passed', () => {
  const log = '✓ PASS — a\n↷ SKIP — provisioner auth — FIRST_ADMIN_DATABASE_URL was not supplied\nProofs: 1 passed, 1 skipped, 0 failed\n';
  const result = parseProofLog(log);
  assert.equal(result.status, 'passed-with-skips');
  assert.deepEqual(result.skippedChecks, ['provisioner auth — FIRST_ADMIN_DATABASE_URL was not supplied']);
});

test('a failed check is named', () => {
  const result = parseProofLog('✗ FAIL — rls isolation\nProofs: 3 passed, 1 failed\n');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failedChecks, ['rls isolation']);
});

test('nested scripts that print PASS lines do not change the counts', () => {
  const result = parseProofLog('✓ PASS — nested\n✓ PASS — nested\n✓ PASS — outer\nProofs: 1 passed, 0 failed\n');
  assert.equal(result.passed, 1);
});

test('a run without a summary line is not-available, never zero', () => {
  const result = parseProofLog('✓ PASS — a\nkilled\n');
  assert.equal(result.status, 'not-available');
  assert.equal(result.passed, undefined);
});

test('node:test JUnit: passed, skipped with reason, failed, entities decoded', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="projection">
		<testcase name="READY &amp; rebuilt" time="0.002" classname="test" file="/repo/services/edge-gateway/test/a.test.ts"/>
		<testcase name="needs a database" time="0" classname="test" file="/repo/services/edge-gateway/test/a.test.ts">
			<skipped type="skipped" message="no DATABASE_URL"/>
		</testcase>
		<testcase name="leaks nothing" time="0.001" classname="test" file="/repo/services/edge-gateway/test/a.test.ts">
			<failure type="testCodeFailure" message="expected &quot;x&quot; to be absent">stack</failure>
		</testcase>
	</testsuite>
</testsuites>`;
  assert.deepEqual(parseJUnit(xml, '/repo'), [
    { name: 'READY & rebuilt', file: 'services/edge-gateway/test/a.test.ts', outcome: 'passed' },
    { name: 'needs a database', file: 'services/edge-gateway/test/a.test.ts', outcome: 'skipped', reason: 'no DATABASE_URL' },
    { name: 'leaks nothing', file: 'services/edge-gateway/test/a.test.ts', outcome: 'failed', reason: 'expected "x" to be absent' },
  ]);
});

test('vitest JUnit: classname is the file, a bare <skipped/> counts', () => {
  const xml = '<testsuites><testsuite name="src/x.test.ts"><testcase classname="src/x.test.ts" name="maps wire" time="0.1"></testcase><testcase classname="src/x.test.ts" name="todo" time="0"><skipped/></testcase></testsuite></testsuites>';
  const cases = parseJUnit(xml, '/repo');
  assert.deepEqual(cases.map((c) => [c.file, c.outcome]), [['src/x.test.ts', 'passed'], ['src/x.test.ts', 'skipped']]);
});

test('node:test JUnit: a raw > inside a failure message does not hide the failure', () => {
  // node:test escapes quotes and ampersands in attributes but writes > as is.
  const xml = '<testsuites><testcase name="compares" classname="test" file="/repo/a.test.mjs" failure="expected 2 > 1"><failure type="testCodeFailure" message="expected 2 > 1 to be false">stack with <br> text</failure></testcase><testcase name="next" classname="test" file="/repo/a.test.mjs"/></testsuites>';
  assert.deepEqual(parseJUnit(xml, '/repo').map((c) => [c.name, c.outcome, c.reason]), [
    ['compares', 'failed', 'expected 2 > 1 to be false'],
    ['next', 'passed', undefined],
  ]);
});

test('a failure without a message keeps its type, else says it had none', () => {
  const xml = '<testsuites><testcase name="a"><failure type="testCodeFailure"/></testcase><testcase name="b"><error/></testcase></testsuites>';
  assert.deepEqual(parseJUnit(xml, '/repo').map((c) => c.reason), ['testCodeFailure', '<error> without a message']);
});

test('CDATA and comments cannot fake a testcase', () => {
  const xml = '<testsuites><!-- <testcase name="ghost"/> --><testcase name="real"><system-out><![CDATA[<testcase name="ghost2"/>]]></system-out></testcase></testsuites>';
  assert.deepEqual(parseJUnit(xml, '/repo').map((c) => c.name), ['real']);
});

test('an empty report has no cases', () => {
  assert.deepEqual(parseJUnit('<testsuites></testsuites>'), []);
});
