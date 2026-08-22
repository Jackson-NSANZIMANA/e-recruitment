// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Hand-rolled S3 SigV4 transport (GET + PUT)
//
// ONE signer, two verbs. Retrieval had its own inline SigV4; the upload
// ingress needs a signed PUT. Copying the recipe would mean two
// implementations of a request signer, one of which misses the next fix — the
// same reasoning that made agency-bff one codebase and three deployments.
//
// Zero npm deps on node:crypto/node:http, the same in-character lineage as the
// hand-rolled G2G HMAC signing (invariant #5). SigV4 with a signed payload
// hash is a fixed, small recipe:
//   canonical request = <METHOD>\n/<bucket>/<key>\n\nhost:..\nx-amz-*:..\n\n
//                       signedHeaders\npayloadHash
//   string to sign    = AWS4-HMAC-SHA256\n<ts>\n<scope>\nsha256(canonical)
//   signing key       = HMAC chain over date/region/service/"aws4_request"
// Region is "us-east-1" (MinIO's default; it accepts it for every bucket).
//
// The payload hash is computed over the ACTUAL body — empty for GET, the sealed
// bytes for PUT — so uploads are signed end-to-end rather than declared
// UNSIGNED-PAYLOAD.
//
// CONTENT-LENGTH IS SET EXPLICITLY on PUT. Without it node:http falls back to
// chunked transfer-encoding, which S3 and MinIO reject for a signed PUT with a
// signature mismatch that looks like a credentials problem and is not.
// ══════════════════════════════════════════════════════════════════

import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ObjectStoreUnavailableError } from '../ports/object-store.js';
import type { ObjectStoreConfig } from '../config.js';

const REGION = 'us-east-1';
const SERVICE = 's3';
const REQUEST_TIMEOUT_MS = 15000;

export interface S3Reply {
  readonly status: number;
  readonly body: Buffer;
}

/**
 * `/bucket/key`, percent-encoded but keeping '/' as a path separator — S3
 * treats slashes in a key as path segments and signs them unencoded.
 */
export function encodeObjectPath(bucket: string, key: string): string {
  return `/${bucket}/${encodeURIComponent(key).replaceAll('%2F', '/')}`;
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

/**
 * Perform one signed S3 request and buffer the whole response.
 *
 * Rejects with ObjectStoreUnavailableError on transport faults (unreachable,
 * timeout, socket error). HTTP status is RETURNED, never thrown — 404 is an
 * outcome for a caller to interpret, not a fault.
 */
export function s3Request(
  config: ObjectStoreConfig,
  method: 'GET' | 'PUT',
  objectPath: string,
  payload: Buffer,
): Promise<S3Reply> {
  const { endpoint, port, useSsl, accessKey, secretKey } = config;
  const host = `${endpoint}:${port}`;
  const amzDate = toAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(payload).digest('hex');

  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    objectPath,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

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

  return new Promise<S3Reply>((resolve, reject) => {
    const doRequest = useSsl ? httpsRequest : httpRequest;
    const req = doRequest(
      {
        host: endpoint,
        port,
        path: objectPath,
        method,
        headers: {
          Host: host,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amzDate,
          Authorization: authorization,
          // Explicit, always: chunked transfer-encoding breaks a signed PUT.
          'Content-Length': payload.length,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(
        new ObjectStoreUnavailableError(`object store timeout after ${REQUEST_TIMEOUT_MS}ms`),
      );
    });
    req.on('error', (cause) => {
      reject(
        cause instanceof ObjectStoreUnavailableError
          ? cause
          : new ObjectStoreUnavailableError('object store request failed', { cause }),
      );
    });
    req.end(payload);
  });
}
