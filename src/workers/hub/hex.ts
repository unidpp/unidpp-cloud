export class HexError extends Error {}

export function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function decodeHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new HexError("not hex (odd length)");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(text[i * 2], 16);
    const lo = parseInt(text[i * 2 + 1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) throw new HexError("not hex");
    out[i] = (hi << 4) | lo;
  }
  return out;
}
