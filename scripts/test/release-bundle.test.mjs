// release-bundle.mjs decides what a release claims; these prove it cannot
// call a release clean when an input is missing, unsigned, unscanned or red.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeBundle, main, readImage, releaseBlockers, summariseEvidence, summariseSbom, summariseTrivy } from '../release-bundle.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const SBOM = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ name: 'x' }, { name: 'y' }] });
const CLEAN_SCAN = JSON.stringify({ Results: [{ Target: 'x', Vulnerabilities: [] }] });
const EVIDENCE = JSON.stringify({
  commit: { sha: SHA, run: 'https://example.invalid/run/1' },
  operations: { status: 'available', count: 47, sha256: 'c'.repeat(64) },
  proofs: { status: 'passed-with-skips', passed: 60, skipped: 1, failed: 0, skippedChecks: ['first-admin'], failedChecks: [] },
  tests: { status: 'passed', totals: { packages: 8, reportedPackages: 8, tests: 300, passed: 299, failed: 0, skipped: 1 }, skippedTests: [{ package: 'p', name: 't' }], failedPackages: [] },
  jobs: { verify: 'success' },
});

function imageDir(root, name, meta, { sbom = SBOM, scan = CLEAN_SCAN } = {}) {
  const dir = join(root, `image-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name, image: `ghcr.io/o/usrp-${name}`, sbom: 'sbom.cdx.json', scan: 'trivy.json', sizeBytes: 100, sizeBudgetBytes: 200, tags: [SHA], ...meta }));
  if (sbom !== null) writeFileSync(join(dir, 'sbom.cdx.json'), sbom);
  if (scan !== null) writeFileSync(join(dir, 'trivy.json'), scan);
  return dir;
}

test('SBOM and scan summaries count what is there and flag what is not', () => {
  assert.equal(summariseSbom(SBOM).components, 2);
  assert.equal(summariseSbom('{"bomFormat":"SPDX"}').status, 'invalid');
  assert.equal(summariseSbom('not json').status, 'invalid');
  const scan = summariseTrivy(JSON.stringify({ Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-1', PkgName: 'p', Severity: 'HIGH' }, { VulnerabilityID: 'CVE-2', PkgName: 'q', Severity: 'LOW' }] }] }));
  assert.deepEqual([scan.critical, scan.high, scan.findings], [0, 1, ['CVE-1 (p)']]);
});

test('evidence summary keeps skips apart from passes', () => {
  const ev = summariseEvidence(EVIDENCE, 'evidence.json');
  assert.equal(ev.proofs.skipped, 1);
  assert.deepEqual(ev.proofs.skippedChecks, ['first-admin']);
  assert.deepEqual(ev.tests.skippedTests, ['p › t']);
  assert.equal(summariseEvidence(null, 'x.json').status, 'not-available');
});

test('a signed, scanned, attested image with green evidence has no release blockers', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  const img = { ...readImage(imageDir(root, 'svc', { digest: DIGEST, signed: true, attested: true })) };
  img.signature = { ...img.signature, verified: true, attestationVerified: true };
  const bundle = composeBundle({ tag: 'v0.1.0-rc1', sha: SHA, mode: 'release', repo: 'r', peer: {}, images: [img], evidence: summariseEvidence(EVIDENCE, 'e.json'), generatedAt: 'now' });
  assert.deepEqual(bundle.blockers, []);
});

test('release mode refuses unpushed, unsigned, unscanned, oversize images and red evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  const unpushed = readImage(imageDir(root, 'a', {}));
  const dirty = readImage(imageDir(root, 'b', { digest: DIGEST, sizeBytes: 300 }, { scan: JSON.stringify({ Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-9', PkgName: 'z', Severity: 'CRITICAL' }] }] }) }));
  const noSbom = readImage(imageDir(root, 'c', { digest: DIGEST }, { sbom: null }));
  const red = summariseEvidence(JSON.stringify({ ...JSON.parse(EVIDENCE), proofs: { status: 'failed', passed: 1, skipped: 0, failed: 1 } }), 'e.json');
  const text = releaseBlockers({ commit: { sha: SHA }, images: [unpushed, dirty, noSbom], evidence: red }).join('\n');
  for (const expected of ['a: no pushed digest', 'a: signature not verified', 'b: 1 critical / 0 high', 'b: 300 bytes over budget 200', 'c: SBOM not-available', 'proofs: failed']) {
    assert.ok(text.includes(expected), `expected blocker "${expected}" in:\n${text}`);
  }
});

test('release mode refuses evidence for a different commit', () => {
  const ev = summariseEvidence(JSON.stringify({ ...JSON.parse(EVIDENCE), commit: { sha: 'f'.repeat(40) } }), 'e.json');
  assert.ok(releaseBlockers({ commit: { sha: SHA }, images: [], evidence: ev }).some((b) => b.includes(`not ${SHA}`)));
});

test('metadata cannot point the reader outside its own directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  const img = readImage(imageDir(root, 'x', { sbom: '../../etc/passwd' }));
  assert.equal(img.sbom.status, 'not-available');
});

test('dry-run writes the bundle and exits 0 without digests; release exits 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  const images = join(root, 'images');
  imageDir(images, 'svc', {});
  writeFileSync(join(root, 'evidence.json'), EVIDENCE);
  const out = join(root, 'out');
  const ctx = { repo: 'r', peerRepo: 'p', peerNote: 'n' };
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(main(['--tag', 'dryrun-1', '--sha', SHA, '--images', images, '--evidence', join(root, 'evidence.json'), '--out', out], ctx), 0);
    const bundle = JSON.parse(readFileSync(join(out, 'release-dryrun-1.json'), 'utf8'));
    assert.equal(bundle.schema, 'usrp-release/v1');
    assert.equal(bundle.images[0].digest, null);
    assert.equal(bundle.images[0].sbom.components, 2);
    assert.equal(main(['--tag', 'v1.0.0', '--sha', SHA, '--images', images, '--evidence', join(root, 'evidence.json'), '--out', out, '--mode', 'release'], ctx), 1);
  } finally {
    console.log = log;
  }
});

test('arguments are validated before anything is written', () => {
  const ctx = { repo: 'r', peerRepo: 'p', peerNote: 'n' };
  assert.throws(() => main(['--tag', '../evil', '--sha', SHA, '--images', '.', '--out', '.'], ctx), /--tag/);
  assert.throws(() => main(['--tag', 'v1', '--sha', 'nope', '--images', '.', '--out', '.'], ctx), /--sha/);
  assert.throws(() => main(['--tag', 'v1', '--sha', SHA, '--images', '.', '--out', '.', '--mode', 'yolo'], ctx), /--mode/);
});
