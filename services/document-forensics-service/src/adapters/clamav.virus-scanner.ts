// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ClamAV adapter (clamd INSTREAM, node:net)
//
// A REAL virus scan, hand-rolled on the clamd TCP wire protocol — zero npm
// deps, same lineage as the hand-rolled Ed25519/HMAC primitives (invariant
// #5). Protocol: send "zINSTREAM\0", then the payload as 4-byte big-endian
// length-prefixed chunks, then a zero-length terminator; clamd answers one
// NUL-terminated line: "stream: OK" or "stream: <signature> FOUND".
// Every failure mode (refused, timeout, malformed reply) maps to UNAVAILABLE
// — the use case fails CLOSED on it; this adapter never guesses "clean".
// ══════════════════════════════════════════════════════════════════

import { connect } from 'node:net';
import type { ScanResult, VirusScanner } from '../ports/virus-scanner.js';
import type { VirusScannerConfig } from '../config.js';

const CHUNK_SIZE = 64 * 1024;

export class ClamavVirusScanner implements VirusScanner {
  readonly #config: VirusScannerConfig;

  constructor(config: VirusScannerConfig) {
    this.#config = config;
  }

  async scan(bytes: Buffer): Promise<ScanResult> {
    try {
      const reply = await this.#instream(bytes);
      return parseReply(reply);
    } catch (cause) {
      return {
        kind: 'UNAVAILABLE',
        detail: cause instanceof Error ? cause.message : 'scanner connection failed',
      };
    }
  }

  #instream(bytes: Buffer): Promise<string> {
    const { host, port, timeoutMs } = this.#config;
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ host, port });
      const received: Buffer[] = [];
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      socket.setTimeout(timeoutMs, () => fail(new Error(`clamd timeout after ${timeoutMs}ms`)));
      socket.on('error', (err) => fail(err));
      socket.on('data', (chunk) => received.push(chunk));
      socket.on('close', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(received).toString('utf8'));
      });

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
          const prefix = Buffer.allocUnsafe(4);
          prefix.writeUInt32BE(chunk.length, 0);
          socket.write(prefix);
          socket.write(chunk);
        }
        const terminator = Buffer.alloc(4); // zero length = end of stream
        socket.write(terminator);
      });
    });
  }
}

function parseReply(reply: string): ScanResult {
  const line = reply.replaceAll('\0', '').trim();
  if (line.endsWith('OK')) return { kind: 'CLEAN' };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found?.[1]) return { kind: 'INFECTED', signature: found[1] };
  return { kind: 'UNAVAILABLE', detail: `unexpected clamd reply: ${line.slice(0, 120)}` };
}
