// base64 encode/decode for payload JSON fields (standard alphabet, padded).
// Chunked btoa keeps call stacks bounded; works in browsers, workers, and node
// (which has global btoa since v16). Payloads are little-endian, and so are
// JS typed arrays on every platform this app targets (x86/ARM), so a plain
// typed-array view over the decoded bytes is exact.

export function b64FromBytes(u8: Uint8Array): string {
  // Native encoder when available (V8 13+): identical output (standard
  // alphabet, padded) without the per-char JS loop (payload encode is a
  // main-thread hot path in client mode).
  if (typeof (u8 as any).toBase64 === 'function') return (u8 as any).toBase64();
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

// convenience for typed arrays that are views over larger buffers
export function b64FromTyped(arr: ArrayBufferView): string {
  return b64FromBytes(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

export function b64Bytes(s: string): Uint8Array {
  // Native decoder when available (V8 13+): same standard-alphabet padded
  // input, same bytes out, minus the per-char loop (mesh/anim payload decode
  // is a main-thread hot path).
  if (typeof (Uint8Array as any).fromBase64 === 'function') {
    return (Uint8Array as any).fromBase64(s) as Uint8Array;
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64f32(s: string): Float32Array { const b = b64Bytes(s); return new Float32Array(b.buffer, 0, b.byteLength >> 2); }
