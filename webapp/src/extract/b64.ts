// base64 encode for payload JSON fields (standard alphabet, padded). Chunked
// btoa keeps call stacks bounded; works in browsers, workers, and node (which
// has global btoa since v16).

export function b64FromBytes(u8: Uint8Array): string {
  // Native encoder when available (V8 13+): identical output — standard
  // alphabet, padded — without the per-char JS loop (payload encode is a
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
