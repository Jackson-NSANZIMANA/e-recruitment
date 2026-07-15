// ══════════════════════════════════════════════════════════════════
// document-forensics-service — MinIO adapter (hand-rolled S3 GET, SigV4)
//
// Retrieval-only S3 GetObject against MinIO, signed with AWS Signature V4
// implemented directly on node:crypto/node:http — zero npm deps, the same
// in-character lineage as the hand-rolled G2G HMAC signing (invariant #5).
// The upload half is deliberately absent (owner decision D3): this service
// analyzes what the (future) portal stores; it never writes objects.
//
// SigV4 for a GET with UNSIGNED payload is a fixed, small recipe:
//   canonical request  = GET\n/<bucket>/<key>\n\nhost:..\nx-amz-*:..\n\n
//                        signedHeaders\npayloadHash
//   string to sign     = AWS4-HMAC-SHA256\n<ts>\n<scope>\nsha256(canonical)
//   signing key        = HMAC chain over date/region/service/"aws4_request"
// Region is "us-east-1" (MinIO's default; it accepts it for all buckets).
// ══════════════════════════════════════════════════════════════════

import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  ObjectStoreUnavailableError,
  type ObjectStore,
} from '../ports/object-store.js';
import type { ObjectStoreConfig } from '../config.js';

const REGION = 'us-east-1';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD_HASH = createHash('sha256').update('').digest('hex');
const REQUEST_TIMEOUT_MS = 15000;

export class MinioObjectStore implements ObjectStore {
  readonly #config: ObjectStoreConfig;

  constructor(config: ObjectStoreConfig) {
    this.#config = config;
  }

  async getObject(bucket: string, key: string): Promise<Buffer | null> {
    const { endpoint, port, useSsl, accessKey, secretKey } = this.#config;
    const path = `/${bucket}/${encodeURIComponent(key).replaceAll('%2F', '/')}`;
    const host = `${endpoint}:${port}`;
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);

    // Canonical request (headers must be sorted, lowercase, trimmed).
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${UNSIGNED_PAYLOAD_HASH}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['GET', path, '', canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD_HASH].join('\n');

    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const signature = createHmac('sha256', signingKey(secretKey, dateStamp))
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return await new Promise<Buffer | null>((resolve, reject) => {
      const doRequest = useSsl ? httpsRequest : httpRequest;
      const req = doRequest(
        {
          host: endpoint,
          port,
          path,
          method: 'GET',
          headers: {
            Host: host,
            'x-amz-content-sha256': UNSIGNED_PAYLOAD_HASH,
            'x-amz-date': amzDate,
            Authorization: authorization,
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve(Buffer.concat(chunks));
            } else if (res.statusCode === 404) {
              resolve(null); // no such key (or bucket) — absence, not a fault
            } else {
              reject(
                new ObjectStoreUnavailableError(
                  `object store returned ${res.statusCode ?? 0} for ${bucket}/${key}`,
                ),
              );
            }
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new ObjectStoreUnavailableError(`object store timeout after ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.on('error', (cause) => {
        reject(
          cause instanceof ObjectStoreUnavailableError
            ? cause
            : new ObjectStoreUnavailableError('object store request failed', { cause }),
        );
      });
      req.end();
    });
  }
}

function toAmzDate(date: Date): string {
  // 20260714T093000Z — ISO basic format
  return date.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function signingKey(secretKey: string, dateStamp: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(REGION, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update(SERVICE, 'utf8').digest();
  return createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}
