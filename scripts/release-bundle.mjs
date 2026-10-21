#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// release-bundle.mjs — write release-<tag>.json (ADR-038, S03)
//
// WHY THIS EXISTS
//
// S00's per-commit evidence bundle says what CI measured for a commit. A
// release has to say more: WHICH BYTES were shipped (image digests), what is
// in them (CycloneDX SBOMs), that they were scanned (Trivy) and signed
// (cosign, keyless), and which commit of the peer repository they go with.
// This script joins those facts into one file that is attached to the GitHub
// Release, so an auditor can go from a running container (GET /version →
// build SHA) to the evidence for that exact commit without trusting a wiki.
//
// INPUTS (all produced by CI, never typed by hand)
//
//   --images <dir>     one sub-directory per image, each with metadata.json
//                      written by the `images` job, plus the SBOM and Trivy
//                      report it names;
//   --evidence <file>  the evidence-<sha>.json of the same commit (S00);
//   --verification <file>  optional: cosign verify results per digest, from
//                      the release workflow;
//   --tag, --sha, --peer-sha, --mode, --run-url, --out.
//
// MODES
//
//   dry-run    PR builds: nothing is pushed or signed, so digests and
//              signatures are recorded as absent. Proves the composer and
//              the inputs on every PR without publishing anything.
//   candidate  main builds: images are pushed and signed; the bundle is what
//              a tag of this commit would release.
//   release    v* tags: every image MUST have a digest and a verified
//              signature and SBOM attestation, a clean scan and a size within
//              budget, and the commit's proofs and unit tests MUST have
//              passed, or the script exits non-zero after writing the file.
//
// "Could not measure" is recorded as `not-available`, never as zero.
// Zero dependencies; Node built-ins only. The frontend repository carries a
// twin (tooling/ci/release-bundle.mjs) with the same schema.
//
//   usage: node scripts/release-bundle.mjs --tag <tag> --sha <sha> --images <dir>
//          [--evidence <file>] [--verification <file>] [--peer-sha <sha>]
//          [--mode dry-run|candidate|release] [--run-url <url>] --out <dir>
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'usrp-release/v1';
const MODES = new Set(['dry-run', 'candidate', 'release']);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// A tag becomes a file name and a registry tag: keep it to what both accept.
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Summarise a CycloneDX SBOM: format, spec version, component count, hash. */
export function summariseSbom(raw) {
  try {
    const doc = JSON.parse(raw);
    if (doc.bomFormat !== 'CycloneDX') return { status: 'invalid', reason: 'not a CycloneDX document' };
    return {
      status: 'available',
      format: 'CycloneDX',
      specVersion: doc.specVersion ?? null,
      components: Array.isArray(doc.components) ? doc.components.length : 0,
      sha256: sha256(raw),
    };
  } catch {
    return { status: 'invalid', reason: 'SBOM is not valid JSON' };
  }
}

/** Count findings by severity in a Trivy JSON report (after its ignore file). */
export function summariseTrivy(raw) {
  try {
    const report = JSON.parse(raw);
    const counts = { CRITICAL: 0, HIGH: 0 };
    const ids = [];
    for (const result of report.Results ?? []) {
      for (const v of result.Vulnerabilities ?? []) {
        if (v.Severity in counts) {
          counts[v.Severity] += 1;
          ids.push(`${v.VulnerabilityID} (${v.PkgName})`);
        }
      }
    }
    return { status: 'available', tool: 'trivy', critical: counts.CRITICAL, high: counts.HIGH, findings: ids };
  } catch {
    return { status: 'invalid', reason: 'Trivy report is not valid JSON' };
  }
}

/** Read one image directory written by the `images` CI job. */
export function readImage(dir) {
  const metaFile = join(dir, 'metadata.json');
  if (!existsSync(metaFile)) return { name: basename(dir), status: 'not-available', reason: 'metadata.json missing' };
  const meta = readJson(metaFile);
  const file = (name) => (typeof name === 'string' && /^[\w.-]+$/.test(name) && existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
  const sbomRaw = file(meta.sbom);
  const trivyRaw = file(meta.scan);
  const digest = typeof meta.digest === 'string' && DIGEST.test(meta.digest) ? meta.digest : null;
  return {
    name: meta.name,
    image: meta.image,
    digest,
    reference: digest === null ? null : `${meta.image}@${digest}`,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    sizeBytes: Number.isSafeInteger(meta.sizeBytes) ? meta.sizeBytes : null,
    sizeBudgetBytes: Number.isSafeInteger(meta.sizeBudgetBytes) ? meta.sizeBudgetBytes : null,
    sbom: sbomRaw === null ? { status: 'not-available', reason: `${meta.sbom ?? 'sbom'} missing` } : { file: meta.sbom, ...summariseSbom(sbomRaw) },
    scan: trivyRaw === null ? { status: 'not-available', reason: `${meta.scan ?? 'scan'} missing` } : { file: meta.scan, ...summariseTrivy(trivyRaw) },
    signature: {
      signed: meta.signed === true,
      attested: meta.attested === true,
      identity: typeof meta.signerIdentity === 'string' ? meta.signerIdentity : null,
      issuer: typeof meta.signerIssuer === 'string' ? meta.signerIssuer : null,
    },
  };
}

/** The parts of the S00 evidence bundle a release cites, skips kept apart. */
export function summariseEvidence(raw, file) {
  if (raw === null) return { status: 'not-available', reason: `evidence bundle not found: ${file}` };
  const ev = JSON.parse(raw);
  const p = ev.proofs ?? {};
  const t = ev.tests ?? {};
  return {
    status: 'available',
    file: basename(file),
    sha256: sha256(raw),
    commit: ev.commit?.sha ?? null,
    run: ev.commit?.run ?? null,
    operations: ev.operations?.status === 'available' ? { count: ev.operations.count, sha256: ev.operations.sha256 } : { status: ev.operations?.status ?? 'not-available' },
    proofs: p.status === undefined || p.status === 'not-available'
      ? { status: 'not-available', reason: p.reason ?? 'absent' }
      : { status: p.status, passed: p.passed, skipped: p.skipped, failed: p.failed, skippedChecks: p.skippedChecks ?? [], failedChecks: p.failedChecks ?? [] },
    tests: t.totals === undefined
      ? { status: t.status ?? 'not-available', reason: t.reason ?? 'absent' }
      : { status: t.status, ...t.totals, skippedTests: (t.skippedTests ?? []).map((s) => `${s.package} › ${s.name}`), failedPackages: t.failedPackages ?? [] },
    jobs: ev.jobs ?? null,
  };
}

/** Merge cosign verification results (from the release workflow) into images. */
export function applyVerification(images, verification) {
  if (verification === null) return images;
  return images.map((img) => {
    const v = img.digest === null || img.digest === undefined ? undefined : verification[img.digest];
    if (v === undefined) return img;
    return { ...img, signature: { ...img.signature, verified: v.signature === true, attestationVerified: v.attestation === true } };
  });
}

/** Every reason this bundle cannot be a release, in release mode. */
export function releaseBlockers(bundle) {
  const blockers = [];
  if (bundle.images.length === 0) blockers.push('no images');
  for (const img of bundle.images) {
    const n = img.name ?? '?';
    if (img.status === 'not-available') { blockers.push(`${n}: ${img.reason}`); continue; }
    if (img.digest === null) blockers.push(`${n}: no pushed digest`);
    if (img.signature.verified !== true) blockers.push(`${n}: signature not verified`);
    if (img.signature.attestationVerified !== true) blockers.push(`${n}: SBOM attestation not verified`);
    if (img.sbom.status !== 'available') blockers.push(`${n}: SBOM ${img.sbom.status}`);
    if (img.scan.status !== 'available') blockers.push(`${n}: scan ${img.scan.status}`);
    else if (img.scan.critical + img.scan.high > 0) blockers.push(`${n}: ${img.scan.critical} critical / ${img.scan.high} high findings`);
    if (img.sizeBytes !== null && img.sizeBudgetBytes !== null && img.sizeBytes > img.sizeBudgetBytes) blockers.push(`${n}: ${img.sizeBytes} bytes over budget ${img.sizeBudgetBytes}`);
  }
  const ev = bundle.evidence;
  if (ev.status !== 'available') blockers.push(`evidence: ${ev.reason}`);
  else {
    if (ev.commit !== bundle.commit.sha) blockers.push(`evidence is for ${ev.commit}, not ${bundle.commit.sha}`);
    if (ev.proofs.status === 'failed' || ev.proofs.status === 'not-available') blockers.push(`proofs: ${ev.proofs.status}`);
    if (ev.tests.status === 'failed' || ev.tests.status === 'not-available') blockers.push(`unit tests: ${ev.tests.status}`);
  }
  return blockers;
}

/** PURE. Assemble the bundle from already-read inputs. */
export function composeBundle({ tag, sha, mode, repo, peer, runUrl, images, evidence, generatedAt }) {
  const bundle = {
    schema: SCHEMA,
    tag,
    mode,
    repo,
    commit: { sha, run: runUrl ?? null },
    peer,
    images: [...images].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    evidence,
    generatedAt,
  };
  return { ...bundle, blockers: mode === 'release' ? releaseBlockers(bundle) : [] };
}

function parseArgs(argv) {
  const args = { mode: 'dry-run', peerSha: null, evidence: null, verification: null, runUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--tag') args.tag = next();
    else if (a === '--sha') args.sha = next();
    else if (a === '--images') args.images = next();
    else if (a === '--evidence') args.evidence = next();
    else if (a === '--verification') args.verification = next();
    else if (a === '--peer-sha') args.peerSha = next();
    else if (a === '--mode') args.mode = next();
    else if (a === '--run-url') args.runUrl = next();
    else if (a === '--out') args.out = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.tag || !TAG.test(args.tag)) throw new Error('--tag <tag> is required ([A-Za-z0-9._-], max 128)');
  if (!args.sha || !SHA.test(args.sha)) throw new Error('--sha <40-hex commit> is required');
  if (!args.images) throw new Error('--images <dir> is required');
  if (!args.out) throw new Error('--out <dir> is required');
  if (!MODES.has(args.mode)) throw new Error(`--mode must be one of ${[...MODES].join(', ')}`);
  if (args.peerSha !== null && args.peerSha !== '' && !SHA.test(args.peerSha)) throw new Error('--peer-sha must be a 40-hex commit');
  return args;
}

export function main(argv, { repo, peerRepo, peerNote }) {
  const args = parseArgs(argv);
  const dirs = existsSync(args.images)
    ? readdirSync(args.images).map((d) => join(args.images, d)).filter((d) => statSync(d).isDirectory()).sort()
    : [];
  const verification = args.verification !== null && existsSync(args.verification) ? readJson(args.verification) : null;
  const images = applyVerification(dirs.map(readImage), verification);
  const evidenceRaw = args.evidence !== null && existsSync(args.evidence) ? readFileSync(args.evidence, 'utf8') : null;
  const peerSha = args.peerSha === null || args.peerSha === '' ? null : args.peerSha;
  const bundle = composeBundle({
    tag: args.tag,
    sha: args.sha,
    mode: args.mode,
    repo,
    peer: { repo: peerRepo, sha: peerSha, note: peerNote },
    runUrl: args.runUrl,
    images,
    evidence: summariseEvidence(evidenceRaw, args.evidence ?? '(none given)'),
    generatedAt: new Date().toISOString(),
  });
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `release-${args.tag}.json`);
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);

  console.log(`release bundle (${bundle.mode}): ${resolve(file)}`);
  for (const img of bundle.images) {
    const size = img.sizeBytes === null || img.sizeBytes === undefined ? '?' : `${(img.sizeBytes / 1e6).toFixed(1)} MB`;
    const scan = img.scan?.status === 'available' ? `${img.scan.critical}C/${img.scan.high}H` : img.scan?.status;
    console.log(`  ${String(img.name).padEnd(28)} ${img.digest ?? '(not pushed)'}  ${size}  sbom:${img.sbom?.components ?? img.sbom?.status}  scan:${scan}  signed:${img.signature?.verified ?? img.signature?.signed}`);
  }
  const ev = bundle.evidence;
  console.log(`  evidence: ${ev.status}${ev.proofs ? `  proofs ${ev.proofs.status} (${ev.proofs.passed ?? '-'} passed, ${ev.proofs.skipped ?? '-'} skipped)` : ''}${ev.tests ? `  tests ${ev.tests.status} (${ev.tests.tests ?? '-'} tests, ${ev.tests.skipped ?? '-'} skipped)` : ''}`);
  for (const b of bundle.blockers) console.log(`  BLOCKER: ${b}`);
  return bundle.blockers.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2), {
      repo: 'Jackson-NSANZIMANA/e-recruitment',
      peerRepo: 'Jackson-NSANZIMANA/e-recruitment-ui',
      peerNote: 'the frontend commit released with this backend tag, from the tag annotation ("peer: <sha>"); null when the tag names none',
    });
  } catch (error) {
    console.error(`release-bundle: ${error.message}`);
    process.exitCode = 2;
  }
}
