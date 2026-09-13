import {
  deriveObjectKey,
  encodeObjectPath,
  s3Request,
} from '../src/index.js';

const MINIO = {
  endpoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
  port: Number(process.env['MINIO_PORT'] ?? '9000'),
  useSsl: false,
  accessKey: process.env['MINIO_ROOT_USER'] ?? 'usrp_minio_admin',
  secretKey: process.env['MINIO_ROOT_PASSWORD'] ?? 'usrp_minio_dev_password',
};
const BUCKET = 'usrp-upload-selfcheck';
const APPLICATION_ID = '7fa22222-2222-4222-8222-222222222222';
const DOCUMENT_TYPES = [
  'NATIONAL_ID',
  'OLEVEL_CERTIFICATE',
  'GOOD_CONDUCT_CERTIFICATE',
  'ALEVEL_CERTIFICATE',
  'CELIBACY_CERTIFICATE',
  'DEGREE_DIPLOMA_COPY',
  'NON_CONVICTION_CERTIFICATE',
] as const;

async function main(): Promise<void> {
  for (const documentType of DOCUMENT_TYPES) {
    const key = deriveObjectKey('RDF', APPLICATION_ID, documentType);
    const reply = await s3Request(MINIO, 'DELETE', encodeObjectPath(BUCKET, key), Buffer.alloc(0));
    if (![200, 204, 404].includes(reply.status)) {
      throw new Error(`could not clean ${BUCKET}/${key}: MinIO returned ${reply.status}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('UPLOAD SELFCHECK CLEANUP FAILED', error);
  process.exit(1);
});
