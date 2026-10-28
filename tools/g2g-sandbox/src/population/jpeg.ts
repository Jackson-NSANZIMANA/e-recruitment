// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — a minimal baseline JPEG encoder for SYNTHETIC placeholders
//
// The Irembo identity record carries a base64 JPEG portrait and signature.
// The sandbox needs valid JPEG bytes of the right kind, never a real face, and
// no dependency. This encoder writes greyscale baseline JPEG where every 8×8
// block is flat (DC coefficient only, AC = end-of-block), so the image is a
// coarse mosaic: unmistakably a placeholder, decodable by any viewer.
// ══════════════════════════════════════════════════════════════════

/** Standard luminance DC table (ITU T.81 K.3): code-length counts and values. */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** A one-symbol AC table: the end-of-block symbol only, as the 1-bit code "0". */
const AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALS = [0x00];

function canonicalCodes(bits: readonly number[], vals: readonly number[]): Map<number, { code: number; length: number }> {
  const table = new Map<number, { code: number; length: number }>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < (bits[length - 1] ?? 0); i += 1) {
      table.set(vals[k] ?? 0, { code, length });
      code += 1;
      k += 1;
    }
    code <<= 1;
  }
  return table;
}

const DC_CODES = canonicalCodes(DC_BITS, DC_VALS);

class BitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private count = 0;

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.count += 1;
      if (this.count === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00); // byte stuffing
    this.acc = 0;
    this.count = 0;
  }

  finish(): number[] {
    while (this.count !== 0) this.write(1, 1); // pad with 1-bits
    return this.bytes;
  }
}

function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

/**
 * Encode a greyscale image whose width and height are multiples of 8, given
 * one shade (0–255) per 8×8 block in raster order.
 */
export function encodeBlockJpeg(blocksWide: number, blocksHigh: number, shades: readonly number[]): Buffer {
  if (shades.length !== blocksWide * blocksHigh) throw new RangeError('one shade per block');
  const width = blocksWide * 8;
  const height = blocksHigh * 8;
  const out: number[] = [0xff, 0xd8];
  out.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
  out.push(...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]));
  out.push(...segment(0xc0, [0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]));
  out.push(...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALS]));
  out.push(...segment(0xc4, [0x10, ...AC_BITS, ...AC_VALS]));
  out.push(...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));

  const bits = new BitWriter();
  let previous = 0;
  for (const shade of shades) {
    const dc = 8 * (Math.max(0, Math.min(255, Math.round(shade))) - 128);
    const diff = dc - previous;
    previous = dc;
    const magnitude = Math.abs(diff);
    const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
    const code = DC_CODES.get(category);
    if (code === undefined) throw new RangeError('DC category out of range');
    bits.write(code.code, code.length);
    if (category > 0) bits.write(diff >= 0 ? diff : diff + (1 << category) - 1, category);
    bits.write(0, 1); // EOB
  }
  out.push(...bits.finish());
  out.push(0xff, 0xd9);
  return Buffer.from(out);
}
