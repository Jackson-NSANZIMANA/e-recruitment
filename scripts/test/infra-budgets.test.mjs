// Proof for the infrastructure decisions that keep the sandbox's broker and document door up:
//   - a Kafka broker's memory limit covers its heap plus JVM non-heap, and its healthcheck (a JVM in the
//     same cgroup) does not inherit the broker's heap: that inheritance OOM-killed the sandbox broker;
//   - the sandbox's MinIO is the image built from infrastructure/docker/minio, its pins are coherent, and
//     the launcher, the compose file and the Dockerfile name the same release.
// Zero dependencies: the compose files are read as text, one service block at a time.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The services of a compose file: name -> its block of text (two-space indented keys under `services:`). */
function services(compose) {
  const body = compose.slice(compose.indexOf('\nservices:\n') + 1);
  const out = {};
  let name = null;
  for (const line of body.split('\n').slice(1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; continue; }
    if (name) out[name] += line + '\n';
  }
  return out;
}

const mib = (v) => { const m = /^(\d+)([MG])$/i.exec(v.trim()); return m[2].toUpperCase() === 'G' ? Number(m[1]) * 1024 : Number(m[1]); };

const KAFKA = [
  ['infrastructure/docker/docker-compose.sandbox.yml', 'sandbox-kafka'],
  ['infrastructure/docker/docker-compose.tier2.yml', 'kafka'],
];

for (const [file, svc] of KAFKA) {
  test(`${svc} (${file}): the memory limit covers the broker heap plus 256 MiB of JVM non-heap and probe`, () => {
    const block = services(read(file))[svc];
    assert.ok(block, `${svc} not found in ${file}`);
    const xmx = /KAFKA_HEAP_OPTS:\s*"[^"]*-Xmx(\d+[MG])/i.exec(block);
    const limit = /memory:\s*(\d+[MG])/i.exec(block);
    assert.ok(xmx && limit, 'heap and limit are both stated');
    assert.ok(mib(limit[1]) >= mib(xmx[1]) + 256, `limit ${limit[1]} < heap ${xmx[1]} + 256M`);
  });

  test(`${svc} (${file}): the healthcheck JVM runs with its own small heap, not the broker's`, () => {
    const block = services(read(file))[svc];
    const hc = /test:\s*(\[.*\])/.exec(block.slice(block.indexOf('healthcheck:')));
    assert.ok(hc, 'a healthcheck test is declared');
    assert.match(hc[1], /kafka-broker-api-versions/);
    const own = /KAFKA_HEAP_OPTS='[^']*-Xmx(\d+)m/i.exec(hc[1]);
    assert.ok(own, 'the probe sets KAFKA_HEAP_OPTS itself (Kafka CLIs otherwise read the broker value)');
    assert.ok(Number(own[1]) <= 64, `probe heap ${own[1]}m is small`);
  });
}

test('the sandbox MinIO is built from the in-repo Dockerfile, and every place names the same release', () => {
  const dockerfile = read('infrastructure/docker/minio/Dockerfile');
  const arg = (k) => new RegExp(`^ARG ${k}=(\\S+)$`, 'm').exec(dockerfile)?.[1];
  const release = arg('MINIO_RELEASE');
  assert.match(release, /^RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  const block = services(read('infrastructure/docker/docker-compose.sandbox.yml'))['sandbox-minio'];
  assert.match(block, new RegExp(`image: \\$\\{SANDBOX_MINIO_IMAGE:-usrp-minio:${release.replaceAll('.', '\\.')}\\}`));
  assert.match(block, /build:\s*\n\s+context: \.\/minio/);
  assert.ok(existsSync(join(ROOT, 'infrastructure/docker', 'minio', 'Dockerfile')));
  assert.ok(read('tools/g2g-sandbox/scripts/sandbox.ts').includes(`'usrp-minio:${release}'`), 'the launcher defaults to the same tag');
});

test('the MinIO Dockerfile pins are coherent: each pseudo-version names its commit, the release its date', () => {
  const dockerfile = read('infrastructure/docker/minio/Dockerfile');
  const arg = (k) => new RegExp(`^ARG ${k}=(\\S+)$`, 'm').exec(dockerfile)?.[1];
  for (const p of ['MINIO', 'MC']) {
    const [release, version, commit] = [arg(`${p}_RELEASE`), arg(`${p}_VERSION`), arg(`${p}_COMMIT`)];
    assert.match(commit, /^[0-9a-f]{40}$/, `${p}_COMMIT is a full commit`);
    assert.match(version, /^v0\.0\.0-\d{14}-[0-9a-f]{12}$/, `${p}_VERSION is a Go pseudo-version`);
    assert.equal(version.slice(-12), commit.slice(0, 12), `${p}_VERSION names ${p}_COMMIT`);
    const stamp = release.replace(/^RELEASE\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, '$1$2$3$4$5$6');
    assert.equal(version.split('-')[1], stamp, `${p}_VERSION's timestamp is ${p}_RELEASE's`);
  }
  assert.match(dockerfile, /^FROM golang:[^@\s]+@sha256:[0-9a-f]{64} AS build$/m, 'the build image is pinned by digest');
  assert.match(dockerfile, /GOSUMDB=sum\.golang\.org/, 'sources are verified against the checksum database');
  assert.match(dockerfile, /--mount=type=secret,id=extra_ca,required=false/, 'an extra CA is a build secret, never a layer');
});

test('the launcher creates bucket and volume without a shell, so a scratch image works', () => {
  const launcher = read('tools/g2g-sandbox/scripts/sandbox.ts');
  assert.doesNotMatch(launcher, /'usrp-sandbox-minio', 'sh', '-c'/);
  assert.match(launcher, /'usrp-sandbox-minio',\s*\n?\s*'mc', 'mb', '--ignore-existing'/);
  assert.match(launcher, /ensureClamavVolume\(\)/);
  assert.match(launcher, /'up', '-d', '--wait', '--pull', 'never', 'sandbox-minio'/);
});
