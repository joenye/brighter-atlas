// ab0 master-datatable parser for the regions the viewer needs:
//
//   region 1 charset     : 2,039 glyphs — the game's text encoding (strings are
//                          varint charset indices, NOT bytes)
//   region 2 audio_dir   : one varint per ab8 object (PCM sample count)
//   region 3 symbols     : 901 '$identifier' strings {u32 BE len, utf8}
//   region 4 hashes      : walked but not kept (content hashes already cover ids)
//   region 6 texture_dir : {flags, n_subimages} per ab3 object
//   region 8 mesh_dir    : {n_vertices, n_triangles, f2, skeleton_ref, 1} per ab5 object
//   region 9 anim_dir    : {ab6_skeleton, duration_ms, 0x14 ms/frame, flags4} per ab1 clip
//   strings              : resolved corpus — full 0x0e sweep over the
//                          object-table + heap, then resolveStrings (text-table
//                          tiling + overlap resolution + junk gate + dedupe)
//
// The parse is self-contained — ab0 bytes only — so the scan-found tables are
// located by structural validation, chained to make a false lock practically
// impossible: a texture_dir candidate must be followed by a valid mesh_dir, a
// mesh_dir candidate by a valid anim_dir (every record carries a literal 0x14
// byte), and an ab2_classes candidate by the object table's 0,1,2,... id chain.
//
// All varints are LSB-first 7-bit (0x80 continuation); fixed ints are big-endian.
// Worker-safe: no DOM, no Node APIs (TextDecoder is available in workers).

import { readVarint } from './bundles.js';

export interface CharsetEntry { ch: string; upper: number; lower: number; flags: number; extras: string[] }
export interface StringCandidate { off: number; end: number; text: string }
export interface StringRecord { off: number; text: string; src: 'table' | 'record'; n: number }
export interface MeshDirEntry { v: number; t: number; u: number; sref: number }
export interface AnimDirEntry { skel: number; dur: number; frameMs: number; flags: number }
export interface TextureDirEntry { flags: number; n: number }
export interface Datatable {
  charset: string[];
  symbols: string[];
  strings: StringRecord[];
  meshDir: MeshDirEntry[];
  animDir: AnimDirEntry[];
  textureDir: TextureDirEntry[];
  audioDir: { samples: number }[];
  objStart: number;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true }); // strict UTF-8
const SCAN_WINDOW = 1 << 21; // search window between regions

// ---------------------------------------------------------------- region 1: charset

// -> { entries: [{ ch, upper, lower, flags, extras }], end }
// Per entry: {varint len, utf8 glyph, u16 upper_idx, u16 lower_idx, u16 flags};
// flags & 0xff = number of extra length-prefixed alternate encodings that follow
// (emoji VS15/VS16 variants). Exported for tests that validate the charset fully.
export function parseCharset(u8: Uint8Array, off: number): { entries: CharsetEntry[]; end: number } {
  let [n, i] = readVarint(u8, off);
  const entries = new Array<CharsetEntry>(n);
  for (let k = 0; k < n; k++) {
    let ln;
    [ln, i] = readVarint(u8, i);
    const ch = UTF8.decode(u8.subarray(i, i + ln));
    i += ln;
    const upper = (u8[i] << 8) | u8[i + 1];
    const lower = (u8[i + 2] << 8) | u8[i + 3];
    const flags = (u8[i + 4] << 8) | u8[i + 5];
    i += 6;
    const extras = [];
    for (let x = flags & 0xff; x > 0; x--) {
      let l2;
      [l2, i] = readVarint(u8, i);
      extras.push(UTF8.decode(u8.subarray(i, i + l2)));
      i += l2;
    }
    entries[k] = { ch, upper, lower, flags, extras };
  }
  if (i > u8.length) throw new Error('ab0: charset overruns file');
  return { entries, end: i };
}

// ---------------------------------------------------------------- small region walkers

function parseVarintArray(u8: Uint8Array, off: number): { values: number[]; end: number } {
  let [n, i] = readVarint(u8, off);
  const values = new Array<number>(n);
  for (let k = 0; k < n; k++) [values[k], i] = readVarint(u8, i);
  if (i > u8.length) throw new Error('ab0: varint array overruns file');
  return { values, end: i };
}

function parseSymbols(u8: Uint8Array, off: number): { symbols: string[]; end: number } {
  let [n, i] = readVarint(u8, off);
  const symbols = new Array<string>(n);
  for (let k = 0; k < n; k++) {
    const ln = ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
    i += 4;
    if (i + ln > u8.length) throw new Error('ab0: symbol overruns file');
    symbols[k] = UTF8.decode(u8.subarray(i, i + ln));
    i += ln;
  }
  return { symbols, end: i };
}

// Region 4 is {u8 tag 0x00, varint count, count x {varint, u64 BE}} — content not
// needed here (the viewer keys assets off content hashes), but it must be walked
// exactly to find where region 5 starts.
function skipHashes(u8: Uint8Array, off: number): number {
  if (u8[off] !== 0x00) throw new Error(`ab0: hash table tag ${u8[off]} != 0`);
  let [n, i] = readVarint(u8, off + 1);
  for (let k = 0; k < n; k++) {
    [, i] = readVarint(u8, i);
    i += 8;
  }
  if (i > u8.length) throw new Error('ab0: hash table overruns file');
  return i;
}

// ---------------------------------------------------------------- scan-located tables
// Regions 5 (grid) and 7 (fftable) are undecoded, so the tables after them are
// found by scanning every offset until a fully-validating parse locks on.

// texture_dir candidate: varint count then {varint flags in {0,1}, varint n} pairs.
// EVERY pair is validated (a >=1000-entry all-{0,1} run cannot occur in the
// grid varint stream, which traces 0..256-range curves).
function tryPairTable(u8: Uint8Array, p: number): { dir: TextureDirEntry[]; end: number } | null {
  let [n, i] = readVarint(u8, p);
  if (n < 1000 || n > 1000000) return null;
  const len = u8.length;
  const dir = new Array<TextureDirEntry>(n);
  for (let k = 0; k < n; k++) {
    let flags, count;
    [flags, i] = readVarint(u8, i);
    if (flags > 1) return null;
    [count, i] = readVarint(u8, i);
    // n_subimages is mips x 3 maps (flags=0) or a record count (flags=1) — small
    if (count > 0xffffff || i > len) return null;
    dir[k] = { flags, n: count };
  }
  return { dir, end: i };
}

// mesh_dir candidate: varint count then 5 varints per record
// {n_vertices, n_triangles, f2, skeleton_ref, 1}. f4 == 1 for every record and
// n_vertices < 200k, checked on ALL records. A candidate is only accepted if a
// valid anim_dir starts EXACTLY at its end, which enforces the known region
// order (8 then 9).
function tryMeshTable(u8: Uint8Array, p: number):
  { dir: MeshDirEntry[]; end: number; anim: { dir: AnimDirEntry[]; end: number } } | null {
  let [n, i] = readVarint(u8, p);
  if (n < 1000 || n > 1000000) return null;
  const len = u8.length;
  const dir = new Array<MeshDirEntry>(n);
  for (let k = 0; k < n; k++) {
    let v, t, f2, sref, f4;
    [v, i] = readVarint(u8, i);
    [t, i] = readVarint(u8, i);
    [f2, i] = readVarint(u8, i);
    [sref, i] = readVarint(u8, i);
    [f4, i] = readVarint(u8, i);
    if (f4 !== 1 || v >= 200000 || i > len) return null;
    dir[k] = { v, t, u: f2, sref };
  }
  const anim = tryAnimDir(u8, i);
  if (!anim) return null;
  return { dir, end: i, anim };
}

// anim_dir: varint count then per clip {varint ab6_skeleton, varint duration_ms,
// u8 0x14 (= 20 ms/frame), 4 flag bytes}. The literal 0x14 in every record makes
// this table self-validating.
function tryAnimDir(u8: Uint8Array, p: number): { dir: AnimDirEntry[]; end: number } | null {
  let [n, i] = readVarint(u8, p);
  if (n < 100 || n > 1000000) return null;
  const len = u8.length;
  const dir = new Array<AnimDirEntry>(n);
  for (let k = 0; k < n; k++) {
    let skel, dur;
    [skel, i] = readVarint(u8, i);
    [dur, i] = readVarint(u8, i);
    if (u8[i] !== 0x14 || i + 5 > len) return null;
    const frameMs = u8[i];
    const flags = ((u8[i + 1] << 24) | (u8[i + 2] << 16) | (u8[i + 3] << 8) | u8[i + 4]) >>> 0;
    i += 5;
    dir[k] = { skel, dur, frameMs, flags };
  }
  return { dir, end: i };
}

// ab2_classes: varint count then one small class id per ab2 object ({501,451,93,11}
// in this cache => far fewer than 64 distinct values). Only needed to bound the
// 'mini' region so the object table (and thus the string sweep start) can be found.
function tryClassTable(u8: Uint8Array, p: number): { end: number } | null {
  let [n, i] = readVarint(u8, p);
  if (n < 1000 || n > 1000000) return null;
  const len = u8.length;
  const seen = new Set<number>();
  for (let k = 0; k < n; k++) {
    let v;
    [v, i] = readVarint(u8, i);
    if (v > 0xfffff || i > len) return null;
    seen.add(v);
    if (seen.size >= 64) return null;
  }
  return { end: i };
}

// Find the offset where the master object registry begins — a 0x00 byte
// (record id 0) from which a chain of records with ids 0,1,2,...,>=40 can be
// parsed, allowing 5..23 varint fields per record.
function findObjectTableStart(u8: Uint8Array, lo: number, hi: number): number | null {
  const len = u8.length;
  for (let cand = lo; cand < hi; cand++) {
    if (u8[cand] !== 0x00) continue;
    const stack: [number, number][] = [[0, cand]];
    const seen = new Set<number>();
    while (stack.length) {
      const [rid, off] = stack.pop()!;
      const key = off * 64 + rid; // rid < 41, off < 2^32 — exact as a double
      if (seen.has(key)) continue;
      seen.add(key);
      if (rid >= 40) return cand;
      if (off >= len) continue;
      let [v, i] = readVarint(u8, off);
      if (v !== rid || i > len) continue;
      let j = i;
      for (let f = 0; f < 5 && j < len; f++) [, j] = readVarint(u8, j);
      for (let nf = 5; nf < 24; nf++) {
        if (j >= len) break;
        const [nid] = readVarint(u8, j);
        if (nid === rid + 1) stack.push([rid + 1, j]);
        [, j] = readVarint(u8, j); // extend the candidate record by one field
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- string sweep

// Full sweep for 0x0e-tagged strings: at EVERY offset in [lo,hi) where the byte is
// 0x0e and {varint n<=4096, n varint charset indices} decodes in-bounds, emit
// {off, end, text}. This applies NO filters and does NOT skip over accepted
// strings: any 0x0e byte inside a float/hash also "decodes", so the raw sweep is
// a noisy superset — resolveStrings below reduces it to the real corpus.
function sweepStrings(u8: Uint8Array, glyphs: string[], lo: number, hi: number): StringCandidate[] {
  const out = [];
  const len = u8.length;
  const nGlyphs = glyphs.length;
  // Allocation-free scan: indexOf jumps between 0x0e bytes (same ascending
  // visit order) and the varints decode inline — no [value, offset] tuple per
  // varint, no string parts until a candidate fully validates. The inlined
  // arithmetic is readVarint's EXACTLY, including reads past the end decoding
  // as byte 0 (undefined & 0x7f === 0, undefined & 0x80 === 0) so overruns
  // still land on the j > len rejection. Acceptance conditions and candidate
  // order are unchanged — the string corpus is threshold-defined.
  const scratch = new Uint32Array(4096);   // n is hard-capped at 4096 below
  for (let i = u8.indexOf(0x0e, lo); i >= 0 && i < hi; i = u8.indexOf(0x0e, i + 1)) {
    let j = i + 1;
    let n = 0, shift = 0, b = 0;
    do { b = u8[j++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    if (n === 0 || n > 4096) continue; // hard cap on string length
    let ok = true;
    for (let k = 0; k < n; k++) {
      let idx = 0;
      shift = 0;
      do { b = u8[j++]; idx += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      if (idx >= nGlyphs) { ok = false; break; }
      scratch[k] = idx;
    }
    if (!ok || j > len) continue;
    const parts = new Array<string>(n);
    for (let k = 0; k < n; k++) parts[k] = glyphs[scratch[k]];
    out.push({ off: i, end: j, text: parts.join('') });
  }
  return out;
}

// ---------------------------------------------------------------- string resolution
// Table-chain detection + max-coverage selection + junk gate + dedupe. The
// thresholds below define the string corpus — do not tweak them.

const TABLE_MIN_ROWS = 256; // a chain this long can only be a real string table

const isPua = (o: number) => (o >= 0xe000 && o <= 0xf8ff)
  || (o >= 0xf0000 && o <= 0xffffd) || (o >= 0x100000 && o <= 0x10fffd);
const ALNUM = /[\p{L}\p{N}]/u;
const CTRL = /\p{C}/u;

// junk gate: no U+FFFD, no control chars (\n\t\r and private-use icon glyphs
// are fine), >= 2 non-space chars, at least one letter/digit
export function stringOk(text: string): boolean {
  if (text.includes('�')) return false;
  if (text.trim().length < 2) return false;
  let hasAlnum = false;
  for (const ch of text) { // iterate code points, not UTF-16 units
    if (!hasAlnum && ALNUM.test(ch)) hasAlnum = true;
    if (ch === '\n' || ch === '\t' || ch === '\r') continue;
    if (isPua(ch.codePointAt(0)!)) continue;
    if (CTRL.test(ch)) return false;
  }
  return hasAlnum;
}

// Sweep candidates -> the clean corpus [{off, text, src, n}], deduplicated by
// text (n = occurrences, first offset kept). A decode is deterministic per
// offset, so `next(c) = candidate starting at c.end` forms a successor graph:
// the longest chains (back-to-back 0x0e records) are the game's canonical text
// table(s) -> src 'table'; outside them, a max-coverage choice of
// non-overlapping gated candidates keeps each real string and drops every
// shifted/glued mis-decode of the same bytes -> src 'record'.
export function resolveStrings(cands: StringCandidate[]): StringRecord[] {
  const n = cands.length;
  const byStart = new Map<number, number>();
  for (let k = 0; k < n; k++) byStart.set(cands[k].off, k);

  // chain depth in the successor graph
  const depth = new Int32Array(n).fill(1);
  for (let k = n - 1; k >= 0; k--) {
    const nk = byStart.get(cands[k].end);
    if (nk !== undefined) depth[k] = 1 + depth[nk];
  }

  // canonical text tables: maximal chains >= TABLE_MIN_ROWS, deepest-first;
  // a root inside a claimed span is a re-synchronized sub-chain, not a table
  const roots = Array.from({ length: n }, (_, k) => k)
    .sort((a, b) => (depth[b] - depth[a]) || (cands[a].off - cands[b].off));
  const spans: [number, number][] = [];
  const tableRows = new Set<number>();
  for (const r of roots) {
    if (depth[r] < TABLE_MIN_ROWS) break;
    if (spans.some(([lo, hi]) => cands[r].off >= lo && cands[r].off < hi)) continue;
    let k: number | undefined = r;
    let last = r;
    while (k !== undefined) {
      tableRows.add(k);
      last = k;
      k = byStart.get(cands[k].end);
    }
    spans.push([cands[r].off, cands[last].end]);
  }
  const hull = spans.length
    ? [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))] : null;

  // outside the table spans: max-coverage non-overlapping selection over the
  // gate-passing candidates (weighted interval scheduling on byte coverage)
  const outside = cands.filter((c) => stringOk(c.text)
    && !spans.some(([lo, hi]) => c.off < hi && c.end > lo))
    .sort((a, b) => a.end - b.end);
  const ends = outside.map((c) => c.end);
  const lastEndingBefore = (x: number, hi: number) => { // upper_bound(ends, x) in [0, hi)
    let lo = 0;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const best = new Float64Array(outside.length + 1);
  const take = new Uint8Array(outside.length);
  const prev = new Int32Array(outside.length);
  for (let k = 0; k < outside.length; k++) {
    const p = lastEndingBefore(outside[k].off, k);
    prev[k] = p;
    const w = outside[k].end - outside[k].off;
    if (best[p] + w > best[k]) { best[k + 1] = best[p] + w; take[k] = 1; }
    else best[k + 1] = best[k];
  }
  const picked = [];
  for (let k = outside.length; k > 0;) {
    if (take[k - 1] && best[k] !== best[k - 1]) { picked.push(outside[k - 1]); k = prev[k - 1]; }
    else k--;
  }

  const rows: [number, string][] = [];
  for (const k of tableRows) if (stringOk(cands[k].text)) rows.push([cands[k].off, cands[k].text]);
  for (const c of picked) rows.push([c.off, c.text]);
  rows.sort((a, b) => a[0] - b[0]);
  const out = [];
  const seen = new Map<string, StringRecord>();
  for (const [off, text] of rows) {
    const e = seen.get(text);
    if (e) { e.n++; continue; }
    const rec: StringRecord = {
      off, text, src: hull && off >= hull[0] && off < hull[1] ? 'table' : 'record', n: 1,
    };
    seen.set(text, rec);
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------- entry point

// u8 = fully-decompressed assetBundle0 bytes.
export function parseDatatable(u8: Uint8Array): Datatable {
  const cs = parseCharset(u8, 0);
  const audio = parseVarintArray(u8, cs.end);
  const sym = parseSymbols(u8, audio.end);
  const e4 = skipHashes(u8, sym.end);

  // regions 6+8+9: scan past the undecoded grid, chain-validated
  let tex: { dir: TextureDirEntry[]; end: number } | null = null;
  let mesh: { dir: MeshDirEntry[]; end: number; anim: { dir: AnimDirEntry[]; end: number } } | null = null;
  for (let p = e4, hi = e4 + SCAN_WINDOW; p < hi && !tex; p++) {
    const t = tryPairTable(u8, p);
    if (!t) continue;
    for (let q = t.end, qhi = t.end + SCAN_WINDOW; q < qhi; q++) {
      const m = tryMeshTable(u8, q);
      if (m) { tex = t; mesh = m; break; }
    }
  }
  if (!tex || !mesh) throw new Error('ab0: texture_dir/mesh_dir not found');

  // region 10 + object table start: scan past the undecoded anim trailer + 'mini'
  let objStart = null;
  for (let p = mesh.anim.end, hi = mesh.anim.end + SCAN_WINDOW; p < hi; p++) {
    const c = tryClassTable(u8, p);
    if (!c) continue;
    objStart = findObjectTableStart(u8, c.end, c.end + 8192);
    if (objStart !== null) break;
  }
  if (objStart === null) throw new Error('ab0: object table not found');

  const glyphs = cs.entries.map((e) => e.ch);
  return {
    charset: glyphs,
    symbols: sym.symbols,
    strings: resolveStrings(sweepStrings(u8, glyphs, objStart, u8.length)),
    meshDir: mesh.dir,
    animDir: mesh.anim.dir,
    textureDir: tex.dir,
    audioDir: audio.values.map((v) => ({ samples: v })),
    objStart, // extra: where the registry/heap begins (the string-sweep range start)
  };
}
