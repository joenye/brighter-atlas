// assetBundle8 audio decoders (QOA + bslpc + Opus packet framing) plus the
// WAV writer. Worker-safe: no DOM, no Node APIs.
//
// Every ab8 object (stored uncompressed) starts with an 8-byte header:
//   off 0  u8     codec: 0x00 bslpc | 0x01 opus | 0x02 qoa
//   off 1  u8     channels (1 or 2)
//   off 2  u32 BE total samples per channel
//   off 6  u8     codec param (bslpc: bits/sample 4..8; opus: kbps 96/192; qoa: 0)
//   off 7  u8     always 0
// The sample rate is not stored. QOA (type 02) + Opus (type 01) are 48000 Hz.
// bslpc (type 00) SFX are sourced at 24000 Hz — the game mixer runs at 48 kHz and
// upsamples them on playback, so decoding + playing at 48 kHz made them an octave
// too high. Decode/play them at 24 kHz for correct pitch.

export const SAMPLE_RATE = 48000;
export const BSLPC_SAMPLE_RATE = 24000;
export const rateForCodec = (codec: string): number =>
  (codec === 'bslpc' ? BSLPC_SAMPLE_RATE : SAMPLE_RATE);

export type AudioCodec = 'bslpc' | 'opus' | 'qoa';
export interface AudioHeader { codec: AudioCodec; ch: number; samples: number; param: number }

const CODEC_NAMES: Record<number, AudioCodec> = { 0: 'bslpc', 1: 'opus', 2: 'qoa' };

function rawHeader(u8: Uint8Array): { codec: number; ch: number; samples: number; param: number } {
  if (u8.length < 8) throw new Error(`audio object too short (${u8.length} bytes)`);
  const samples = ((u8[2] << 24) | (u8[3] << 16) | (u8[4] << 8) | u8[5]) >>> 0;
  return { codec: u8[0], ch: u8[1], samples, param: u8[6] };
}

export function parseAudioHeader(u8: Uint8Array): AudioHeader {
  const h = rawHeader(u8);
  const codec = CODEC_NAMES[h.codec];
  if (!codec) throw new Error(`unknown audio codec byte 0x${h.codec.toString(16)}`);
  return { codec, ch: h.ch, samples: h.samples, param: h.param };
}

// index/audio.json entry fields derived from the header ('h' and 'f' are
// added by the ingest coordinator, not derivable here).
export function audioIndexEntry(u8: Uint8Array, i: number) {
  const h = parseAudioHeader(u8);
  const sr = rateForCodec(h.codec);
  return { i, codec: h.codec, ch: h.ch, sr, n: h.samples,
           dur: durFromSamples(h.samples, sr), approx: false };
}

// The index rounds samples/rate to 2 decimals HALF-TO-EVEN on the exact binary
// value of the double; toFixed(2) rounds that same exact value but half-UP.
// They differ only when the double is exactly halfway, which for a dyadic
// x = samples/rate happens iff x = odd/8 (samples = rate/8·odd; any other .xx5
// decimal is not a dyadic rational, far above the ~1e-14 division error — so
// no other double can land halfway). rate is a multiple of 8.
function durFromSamples(samples: number, rate: number): number {
  const x = samples / rate;
  if (rate % 8 === 0 && samples % (rate / 4) === rate / 8) {
    const q = Math.floor(x * 100); // pick the even neighbour
    return (q % 2 ? q + 1 : q) / 100;
  }
  return Number(x.toFixed(2));
}

// Correct a persisted audio index entry's stale display metadata on load, so a
// re-extract isn't required (playback is always decoded live from the raw bytes):
//   - sr/dur: indexes built before the bslpc 24 kHz change stored sr=48000/half-dur.
//   - approx: indexes built before the bslpc ADPCM decode was cracked stored
//     approx=true; nothing is approximate any more, so clear the badge.
// Idempotent.
export function correctAudioRate(e: any) {
  const sr = rateForCodec(e.codec);
  if (e.sr === sr && !e.approx) return e;
  return { ...e, sr, dur: durFromSamples(e.n, sr), approx: false };
}

// ---------------------------------------------------------------------------
// Type 0x02 — QOA (qoa.h) with file/frame headers stripped and u64s LITTLE-endian.
// Frames are implicitly 5120 samples; each frame stores per-channel LMS history+weights
// (4 x s16 packed MSB-first in a u64le), then ceil(flen/20) slice rows of one u64le per
// channel. Decode is bit-exact qoa.h once the u64s are byteswapped.

const QOA_SLICE_LEN = 20;
const QOA_FRAME_LEN = 5120;

// prettier layout: QOA_DEQUANT[sf*8 + quant]
const QOA_DEQUANT = Int32Array.from([
  1, -1, 3, -3, 5, -5, 7, -7,
  5, -5, 18, -18, 32, -32, 49, -49,
  16, -16, 53, -53, 95, -95, 147, -147,
  34, -34, 113, -113, 203, -203, 315, -315,
  63, -63, 210, -210, 378, -378, 588, -588,
  104, -104, 345, -345, 621, -621, 966, -966,
  158, -158, 528, -528, 950, -950, 1477, -1477,
  228, -228, 760, -760, 1368, -1368, 2128, -2128,
  316, -316, 1053, -1053, 1895, -1895, 2947, -2947,
  422, -422, 1405, -1405, 2529, -2529, 3934, -3934,
  548, -548, 1828, -1828, 3290, -3290, 5117, -5117,
  696, -696, 2320, -2320, 4176, -4176, 6496, -6496,
  868, -868, 2893, -2893, 5207, -5207, 8099, -8099,
  1064, -1064, 3548, -3548, 6386, -6386, 9933, -9933,
  1286, -1286, 4288, -4288, 7718, -7718, 12005, -12005,
  1536, -1536, 5120, -5120, 9216, -9216, 14336, -14336,
]);

// -> Int16Array, interleaved (samples * ch)
export function decodeQoa(u8: Uint8Array): Int16Array {
  const hdr = rawHeader(u8);
  if (hdr.codec !== 2) throw new Error(`not a qoa object (codec=${hdr.codec})`);
  const ch = hdr.ch, samples = hdr.samples;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Int16Array(samples * ch);
  // per-channel LMS state; weights drift up to +-896/sample within a 5120-sample frame, so
  // they exceed int16 but stay far below 2^53 — plain Number arithmetic is exact
  // (state is reloaded from the stream every frame).
  const hist = new Int32Array(ch * 4);
  const wts = new Float64Array(ch * 4);
  let pos = 8;
  let sampleIndex = 0;
  while (sampleIndex < samples) {
    const flen = Math.min(QOA_FRAME_LEN, samples - sampleIndex);
    const nslices = Math.ceil(flen / QOA_SLICE_LEN);
    for (let c = 0; c < ch; c++) {
      // u64le lanes MSB-first in the value => s16le lanes at byte offsets 6,4,2,0
      for (let l = 0; l < 4; l++) hist[c * 4 + l] = dv.getInt16(pos + 6 - 2 * l, true);
      pos += 8;
      for (let l = 0; l < 4; l++) wts[c * 4 + l] = dv.getInt16(pos + 6 - 2 * l, true);
      pos += 8;
    }
    // slice rows are channel-interleaved exactly as qoa.h: slice0 ch0, slice0 ch1, slice1 ch0…
    for (let s = 0; s < nslices; s++) {
      for (let c = 0; c < ch; c++) {
        const lo = dv.getUint32(pos, true), hi = dv.getUint32(pos + 4, true);
        pos += 8;
        const dqBase = (hi >>> 28) * 8; // sf = u64 bits 60..63
        let h0 = hist[c * 4], h1 = hist[c * 4 + 1], h2 = hist[c * 4 + 2], h3 = hist[c * 4 + 3];
        let w0 = wts[c * 4], w1 = wts[c * 4 + 1], w2 = wts[c * 4 + 2], w3 = wts[c * 4 + 3];
        const n = Math.min(QOA_SLICE_LEN, flen - s * QOA_SLICE_LEN);
        let oi = (sampleIndex + s * QOA_SLICE_LEN) * ch + c;
        for (let k = 0; k < n; k++) {
          // 3-bit residual k sits at u64 bits (57-3k)..(59-3k); bit 30..32 spans lo/hi
          const shift = 57 - 3 * k;
          const q = shift >= 32 ? (hi >>> (shift - 32)) & 7
            : shift === 30 ? ((lo >>> 30) | (hi << 2)) & 7
            : (lo >>> shift) & 7;
          const d = QOA_DEQUANT[dqBase + q];
          // prediction: |w| < 2^23, |h| <= 2^15 => the dot product < 2^53, exact in doubles;
          // /8192 is a power of two so Math.floor(p/8192) == arithmetic >>13 at any width
          let r = Math.floor((w0 * h0 + w1 * h1 + w2 * h2 + w3 * h3) / 8192) + d;
          if (r > 32767) r = 32767; else if (r < -32768) r = -32768;
          const delta = d >> 4;
          w0 += h0 < 0 ? -delta : delta;
          w1 += h1 < 0 ? -delta : delta;
          w2 += h2 < 0 ? -delta : delta;
          w3 += h3 < 0 ? -delta : delta;
          h0 = h1; h1 = h2; h2 = h3; h3 = r;
          out[oi] = r;
          oi += ch;
        }
        hist[c * 4] = h0; hist[c * 4 + 1] = h1; hist[c * 4 + 2] = h2; hist[c * 4 + 3] = h3;
        wts[c * 4] = w0; wts[c * 4 + 1] = w1; wts[c * 4 + 2] = w2; wts[c * 4 + 3] = w3;
      }
    }
    sampleIndex += flen;
  }
  if (pos !== u8.length) throw new Error(`qoa: consumed ${pos} != size ${u8.length}`);
  return out;
}

// ---------------------------------------------------------------------------
// Type 0x00 — "bslpc": backward-adaptive ADPCM (IMA/G.726-style). Each
// 2048-sample superframe re-seeds a predictor from the s16 anchor and a step
// index from the magnitude byte; each 128-sample frame's header byte selects a
// step-adaptation profile. Per code: pred += code*step +/- step/2 (clamped
// s16); the step index adapts by an offset-table delta keyed on |code|, and
// step follows the index. The int16 predictor IS the output sample (no extra
// scaling).

const T00_FRAME = 128;       // samples per frame
const T00_SUPERFRAME = 2048; // samples per superframe (= 16 frames)

// ADPCM tables: STEP (5 per-B step tables x 89 entries), OFF9/OFF17 (256-row
// signed step-index deltas, width 9 for B4/B5, width 17 for B6/B7/B8).
// Stored base64 to stay compact and byte-exact — never regenerate these.
const _B64_STEP = 'AQACAAMABAAFAAYACAAJAAsADQAPABEAEwAWABgAGwAeACIAJQApAC0AMgA2ADwAQQBHAE4AVQBcAGUAbQB3AIEAjACYAKUAsgDBANEA4gD1AAkBHgE2AU8BagGHAaYByAHtARQCPgJsAp0C0gILA0kDiwPSAx8EcwTMBC0FlQUFBn0GAAeMByMIxgh2CTMK/wrbC8gMyA3bDgQQRBGdEhAUoRVQFyEZFxszHXof7SGSJAEAAgADAAQABQAGAAgACQALAAwADgAQABIAFAAXABkAHAAeACEAJQAoACwAMAA0ADgAPQBCAEcATQBTAFkAYABoAHAAeACBAIsAlQCgAKsAuADFANMA4gDyAAMBFQEpAT0BVAFrAYQBnwG8AdoB+wEeAkMCagKVAsIC8QIlA1sDlQPUAxYEXASoBPgETgWpBQsGcwbiBlgH1wddCO0IhgkqCtgKkgtZDCwNDg7/Dv8PEREBAAIAAwAEAAUABgAHAAkACgAMAA0ADwARABMAFQAXABkAHAAeACEAJAAnACoALQAxADQAOAA8AEEARQBKAE8AVABaAGAAZgBtAHQAfACEAIwAlQCeAKgAsgC9AMgA1QDhAO8A/QAMARwBLQE/AVIBZgF6AZEBqAHBAdsB9gETAjICUgJ0ApgCvgLmAhEDPQNtA58D0wMLBEYEhATFBAoFUwWgBfEFRwaiBgIHZwfRB0IIAQACAAMABAAFAAYABwAJAAoACwANAA4AEAASABMAFQAXABkAGwAeACAAIgAlACcAKgAtADAAMwA2ADoAPQBBAEUASQBNAFIAVgBbAGAAZgBrAHEAdwB9AIQAiwCSAJoAogCqALIAuwDFAM8A2QDkAO8A+gAHARMBIQEvAT0BTAFcAW0BfgGQAaMBtwHMAeIB+AEQAigCQgJdAnkClwK1AtYC9wIaAz8DZQONA7cD4gMQBAEAAgADAAQABQAGAAcACAAKAAsADAAOAA8AEAASABQAFQAXABkAGwAcAB4AIAAiACUAJwApACsALgAwADMANgA4ADsAPgBBAEUASABLAE8AUgBWAFoAXgBiAGYAawBvAHQAeQB+AIMAiQCOAJQAmgCgAKcArQC0ALsAwgDKANEA2QDiAOoA8wD8AAYBEAEaASQBLwE6AUYBUgFeAWsBeAGFAZMBogGxAcEB0QHhAfIBBAI=';
const _B64_OFF9 = '////////AAIC////////AAMD////////AAQE////////AAUF////////AAYG////////AAcH////////AQEB////////AQIC////////AQMD////////AQQE////////AQUF////////AQYG////////AQcH////////AQgI////////AgMD////////AgQE////////AgUF////////AgYG////////AgcH////////AggI////////AgkJ////////AwUF////////AwYG////////AwcH////////AwgI////////AwkJ////////AwoK////////BAcH////////BAgI////////BAkJ////////BAoK////////BAsL////////BQkJ////////BQoK////////BQsL////////BQwM//////8AAAAA//////8AAAIC//////8AAAQE//////8AAAYG//////8AAQIC//////8AAQQE//////8AAQYG//////8AAQgI//////8AAgQE//////8AAgYG//////8AAggI//////8AAwYG//////8AAwgI//////8AAwoK//////8ABAgI//////8ABAoK//////8ABQoK//////8ABQwM//////8ABgwM//////8BAQEB//////8BAQQE//////8BAQcH//////8BAgMD//////8BAgYG//////8BAgkJ//////8BAwUF//////8BAwgI//////8BBAcH//////8BBAoK//////8BBQkJ//////8BBQwM//////8BBgsL//////8BBw0N//////8CAwQE//////8CAwgI//////8CBAYG//////8CBAoK//////8CBQgI//////8CBQwM//////8CBgoK//////8CBwwM//////8CCA4O//////8DBQcH//////8DBQwM//////8DBgkJ//////8DBwsL//////8DCA0N//////8DCQ8P//////8EBwoK//////8ECAwM//////8ECQ4O//////8EChAQ/////wAAAAAA/////wAAAAIC/////wAAAAQE/////wAAAAYG/////wAAAgIC/////wAAAgQE/////wAAAgYG/////wAAAggI/////wAABAYG/////wAABAgI/////wAABAoK/////wAABgoK/////wAABgwM/////wABAgMD/////wABAgUF/////wABAgcH/////wABAgkJ/////wABBAcH/////wABBAkJ/////wABBAsL/////wABBgsL/////wABBg0N/////wACBAYG/////wACBAkJ/////wACBgoK/////wACBg0N/////wACCA4O/////wADBgkJ/////wADBg0N/////wADCA0N/////wAECAwM/////wAEChAQ/////wAFCg8P/////wEBAQEB/////wEBAQQE/////wEBAQcH/////wEBBAUF/////wEBBAgI/////wEBBAsL/////wEBBwsL/////wEBBw4O/////wECAwQE/////wECAwcH/////wECAwoK/////wECBgoK/////wECBg0N/////wEDBQcH/////wEDBQoK/////wEDCA0N/////wEEBwoK/////wEEBw4O/////wEEChAQ/////wEFCQ0N/////wEGCxAQ/////wIDBAUF/////wIDBAkJ/////wIDCA0N/////wIEBggI/////wIEBgwM/////wIEChAQ/////wIFCAsL/////wIFCA8P/////wIGCg4O/////wIHDBER////AAAAAAAA////AAAAAAEB////AAAAAAIC////AAAAAAMD////AAAAAAQE////AAAAAAUF////AAAAAAYG////AAAAAAcH////AAAAAgIC////AAAAAgMD////AAAAAgQE////AAAAAgUF////AAAAAgYG////AAAAAgcH////AAAAAggI////AAAAAgkJ////AAAABAYG////AAAABAcH////AAAABAgI////AAAABAkJ////AAAABAoK////AAAABAsL////AAAABgoK////AAAABgsL////AAAABgwM////AAAABg0N////AAACAgIC////AAACAgUF////AAACAggI////AAACBAYG////AAACBAkJ////AAACBgoK////AAACBg0N////AAACCA4O////AAAEBggI////AAAEBg0N////AAAECAwM////AAAEChAQ////AAECAwQE////AAECAwYG////AAECAwgI////AAECAwoK////AAECBQgI////AAECBQoK////AAECBQwM////AAECBwwM////AAECBw4O////AAEEBwoK////AAEEBw4O////AAEECQ4O////AAEGCxAQ////AAIEBggI////AAIEBgsL////AAIECQ4O////AAIGCg4O////AAMGCQwM////AAMGCRAQ////AAMIDRIS////AQEBAQEB////AQEBAQIC////AQEBAQMD////AQEBAQQE////AQEBAQUF////AQEBAQYG////AQEBAQcH////AQEBAQgI////AQEBBAUF////AQEBBAYG////AQEBBAcH////AQEBBAgI////AQEBBAkJ////AQEBBAoK////AQEBBAsL////AQEBBwsL////AQEBBwwM////AQEBBw0N////AQEBBw4O////AQEEBQYG////AQEEBQoK////AQEECAwM////AQIDBAUF////AQIDBAcH////AQIDBAkJ////AQIDBAsL////AQIDBwsL////AQIDBw0N////AQIGCg4O////AQMFBwkJ////AQMFBwwM////AQMFCg8P////AQMIDRIS////AQQHCg0N////AQQHChER////AgMEBQYG////AgMEBQgI////AgMEBQoK////AgMEBQwM////AgMECQ4O////AgMECRAQ////AgMIDRIS////AgQGCAoK////AgQGCA0N////AgQGDBIS////AgUICw4O';
const _B64_OFF17 = '////////////////AAECAgL///////////////8AAQMDA////////////////wACBAQE////////////////AAIFBQX///////////////8AAwYGBv///////////////wADBwcH//////////////8AAQEBAQH//////////////wABAQICAv//////////////AAECAwMD//////////////8AAQIEBAT//////////////wABAwUFBf//////////////AAEDBgYG//////////////8AAQQHBwf//////////////wABBAgICP//////////////AAICAwMD//////////////8AAgMEBAT//////////////wACAwUFBf//////////////AAIEBgYG//////////////8AAgQHBwf//////////////wACBQgICP//////////////AAIFCQkJ//////////////8BAwQFBQX//////////////wEDBAYGBv//////////////AQMFBwcH//////////////8BAwUICAj//////////////wEDBgkJCf//////////////AQMGCgoK//////////////8BBAUHBwf//////////////wEEBggICP//////////////AQQGCQkJ//////////////8BBAcKCgr//////////////wEEBwsLC///////////////AgUHCQkJ//////////////8CBQcKCgr//////////////wIFCAsLC///////////////AgUIDAwM/////////////wAAAAAAAAD/////////////AAAAAQICAv////////////8AAAACBAQE/////////////wAAAAMGBgb/////////////AAABAQICAv////////////8AAAECBAQE/////////////wAAAQMGBgb/////////////AAABBAgICP////////////8AAQIDBAQE/////////////wABAgQGBgb/////////////AAECBQgICP////////////8AAQMEBgYG/////////////wABAwUICAj/////////////AAEDBgoKCv////////////8AAgQGCAgI/////////////wACBAcKCgr/////////////AAIFBwoKCv////////////8AAgUIDAwM/////////////wADBgkMDAz///////////8AAQEBAQEBAf///////////wABAQECBAQE////////////AAEBAQQHBwf///////////8AAQECAgMDA////////////wABAQIEBgYG////////////AAEBAgUJCQn///////////8AAQIDBAUFBf///////////wABAgMFCAgI////////////AAECBAUHBwf///////////8AAQIEBwoKCv///////////wABAwUHCQkJ////////////AAEDBQgMDAz///////////8AAQMGCAsLC////////////wABBAcKDQ0N////////////AAICAwMEBAT///////////8AAgIDBQgICP///////////wACAwQFBgYG////////////AAIDBAcKCgr///////////8AAgMFBggICP///////////wACAwUIDAwM////////////AAIEBggKCgr///////////8AAgQHCQwMDP///////////wACBQgLDg4O////////////AQMEBQYHBwf///////////8BAwQFCAwMDP///////////wEDBAYHCQkJ////////////AQMFBwkLCwv///////////8BAwUICg0NDf///////////wEDBgkMDw8P////////////AQQFBwgKCgr///////////8BBAYICgwMDP///////////wEEBgkLDg4O////////////AQQHCg0QEBD//////////wAAAAAAAAAAAP//////////AAAAAAABAgIC//////////8AAAAAAAIEBAT//////////wAAAAAAAwYGBv//////////AAAAAQICAgIC//////////8AAAABAgMEBAT//////////wAAAAECBAYGBv//////////AAAAAQIFCAgI//////////8AAAACBAUGBgb//////////wAAAAIEBggICP//////////AAAAAgQHCgoK//////////8AAAADBggKCgr//////////wAAAAMGCQwMDP//////////AAABAQICAwMD//////////8AAAEBAgMFBQX//////////wAAAQECBAcHB///////////AAABAQIFCQkJ//////////8AAAECBAUHBwf//////////wAAAQIEBgkJCf//////////AAABAgQHCwsL//////////8AAAEDBggLCwv//////////wAAAQMGCQ0NDf//////////AAECAwQFBgYG//////////8AAQIDBAYJCQn//////////wABAgQGCAoKCv//////////AAECBAYJDQ0N//////////8AAQIFCAsODg7//////////wABAwQGBwkJCf//////////AAEDBAYJDQ0N//////////8AAQMFCAoNDQ3//////////wACBAYICgwMDP//////////AAIEBwoNEBAQ//////////8AAgUHCgwPDw//////////AAEBAQEBAQEBAf////////8AAQEBAQECBAQE/////////wABAQEBAQQHBwf/////////AAEBAQIEBAUFBf////////8AAQEBAgQGCAgI/////////wABAQECBAcLCwv/////////AAEBAQQHCQsLC/////////8AAQEBBAcKDg4O/////////wABAQICAwMEBAT/////////AAEBAgIDBQcHB/////////8AAQECAgMGCgoK/////////wABAQIEBggKCgr/////////AAEBAgQGCQ0NDf////////8AAQIDBAUGBwcH/////////wABAgMEBQcKCgr/////////AAECAwUICg0NDf////////8AAQIEBQcICgoK/////////wABAgQFBwoODg7/////////AAECBAcKDRAQEP////////8AAQMFBwkLDQ0N/////////wABAwYICw0QEBD/////////AAICAwMEBAUFBf////////8AAgIDAwQGCQkJ/////////wACAgMFCAoNDQ3/////////AAIDBAUGBwgICP////////8AAgMEBQYJDAwM/////////wACAwQHCg0QEBD/////////AAIDBQYICQsLC/////////8AAgMFBggLDw8P/////////wACBAYICgwODg7/////////AAIEBwkMDhEREf///////wAAAAAAAAAAAAAA////////AAAAAAAAAAABAQH///////8AAAAAAAAAAQICAv///////wAAAAAAAAABAwMD////////AAAAAAAAAAIEBAT///////8AAAAAAAAAAgUFBf///////wAAAAAAAAADBgYG////////AAAAAAAAAAMHBwf///////8AAAAAAAECAgICAv///////wAAAAAAAQICAwMD////////AAAAAAABAgMEBAT///////8AAAAAAAECAwUFBf///////wAAAAAAAQIEBgYG////////AAAAAAABAgQHBwf///////8AAAAAAAECBQgICP///////wAAAAAAAQIFCQkJ////////AAAAAAACBAUGBgb///////8AAAAAAAIEBQcHB////////wAAAAAAAgQGCAgI////////AAAAAAACBAYJCQn///////8AAAAAAAIEBwoKCv///////wAAAAAAAgQHCwsL////////AAAAAAADBggKCgr///////8AAAAAAAMGCAsLC////////wAAAAAAAwYJDAwM////////AAAAAAADBgkNDQ3///////8AAAABAgICAgICAv///////wAAAAECAgIDBQUF////////AAAAAQICAgUICAj///////8AAAABAgMEBQYGBv///////wAAAAECAwQGCQkJ////////AAAAAQIEBggKCgr///////8AAAABAgQGCQ0NDf///////wAAAAECBQgLDg4O////////AAAAAgQFBgcICAj///////8AAAACBAUGCQ0NDf///////wAAAAIEBggKDAwM////////AAAAAgQHCg0QEBD///////8AAAEBAgIDAwQEBP///////wAAAQECAgMEBgYG////////AAABAQICAwUICAj///////8AAAEBAgIDBgoKCv///////wAAAQECAwUGCAgI////////AAABAQIDBQcKCgr///////8AAAEBAgMFCAwMDP///////wAAAQECBAcJDAwM////////AAABAQIEBwoODg7///////8AAAECBAUHCAoKCv///////wAAAQIEBQcKDg4O////////AAABAgQGCQsODg7///////8AAAEDBggLDRAQEP///////wABAgMEBQYHCAgI////////AAECAwQFBggLCwv///////8AAQIDBAYJCw4ODv///////wABAgQGCAoMDg4O////////AAEDBAYHCQoMDAz///////8AAQMEBgcJDBAQEP///////wABAwUICg0PEhIS//////8AAQEBAQEBAQEBAQH//////wABAQEBAQEBAQICAv//////AAEBAQEBAQECAwMD//////8AAQEBAQEBAQIEBAT//////wABAQEBAQEBAwUFBf//////AAEBAQEBAQEDBgYG//////8AAQEBAQEBAQQHBwf//////wABAQEBAQEBBAgICP//////AAEBAQEBAgQEBQUF//////8AAQEBAQECBAUGBgb//////wABAQEBAQIEBQcHB///////AAEBAQEBAgQGCAgI//////8AAQEBAQECBAYJCQn//////wABAQEBAQIEBwoKCv//////AAEBAQEBAgQHCwsL//////8AAQEBAQEEBwkLCwv//////wABAQEBAQQHCQwMDP//////AAEBAQEBBAcKDQ0N//////8AAQEBAQEEBwoODg7//////wABAQECBAQFBQYGBv//////AAEBAQIEBAUHCgoK//////8AAQEBAgQGCAoMDAz//////wABAQICAwMEBAUFBf//////AAEBAgIDAwQFBwcH//////8AAQECAgMDBAYJCQn//////wABAQICAwMEBwsLC///////AAEBAgIDBQcJCwsL//////8AAQECAgMFBwoNDQ3//////wABAQIEBggKDA4ODv//////AAECAwQFBgcICQkJ//////8AAQIDBAUGBwkMDAz//////wABAgMEBQcKDA8PD///////AAECAwUICg0PEhIS//////8AAQIEBQcICgsNDQ3//////wABAgQFBwgKDREREf//////AAICAwMEBAUFBgYG//////8AAgIDAwQEBQYICAj//////wACAgMDBAQFBwoKCv//////AAICAwMEBAUIDAwM//////8AAgIDAwQGCQsODg7//////wACAgMDBAYJDBAQEP//////AAICAwUICg0PEhIS//////8AAgMEBQYHCAkKCgr//////wACAwQFBgcICg0NDf//////AAIDBAUGCQwPEhIS//////8AAgMFBggJCwwODg4=';
function _b64ToU8(s: string): Uint8Array {
  const bin = atob(s), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
const BSLPC_STEP = (() => {                     // [B-4] -> Int32Array(89)
  const b = _b64ToU8(_B64_STEP), t: Int32Array[] = [];
  for (let g = 0; g < 5; g++) {
    const a = new Int32Array(89);
    for (let i = 0; i < 89; i++) a[i] = b[(g * 89 + i) * 2] | (b[(g * 89 + i) * 2 + 1] << 8);
    t.push(a);
  }
  return t;
})();
function _offTab(u8: Uint8Array, width: number): Int8Array[] { // 256 rows of signed int8
  const rows = [];
  for (let r = 0; r < 256; r++) {
    const row = new Int8Array(width);
    for (let c = 0; c < width; c++) { const v = u8[r * width + c]; row[c] = v > 127 ? v - 256 : v; }
    rows.push(row);
  }
  return rows;
}
const BSLPC_OFF9 = _offTab(_b64ToU8(_B64_OFF9), 9);    // B4, B5
const BSLPC_OFF17 = _offTab(_b64ToU8(_B64_OFF17), 17); // B6, B7, B8
const BSLPC_SHIFT: Record<number, number> = { 4: 0, 5: 1, 6: 1, 7: 2, 8: 3 };

// n <= 16 bits MSB-first at bit position pos; framing guarantees in-bounds reads
function readBits(u8: Uint8Array, pos: number, n: number): number {
  const i = pos >> 3, off = pos & 7;
  const w = (u8[i] << 16) | (u8[i + 1] << 8) | (u8[i + 2] | 0);
  return (w >>> (24 - off - n)) & ((1 << n) - 1);
}

// -> Int16Array, interleaved (samples * ch)
export function decodeType00(u8: Uint8Array): Int16Array {
  const hdr = rawHeader(u8);
  if (hdr.codec !== 0) throw new Error(`not a bslpc object (codec=${hdr.codec})`);
  const ch = hdr.ch, samples = hdr.samples, B = hdr.param;
  if (ch < 1 || ch > 2 || B < 4 || B > 8) throw new Error(`bslpc: bad header ch=${ch} B=${B}`);
  const bits = u8.subarray(8);
  const out = new Int16Array(samples * ch);
  const stepTab = BSLPC_STEP[B - 4];
  const offTab = B < 6 ? BSLPC_OFF9 : BSLPC_OFF17;
  const shift = BSLPC_SHIFT[B];
  const half = 1 << (B - 1), full = 1 << B;
  const frames = Math.ceil(samples / T00_FRAME);
  const superframes = Math.ceil(frames / 16);
  let p = 0; // bit position; ONE stream — channels follow each other inside a superframe
  for (let j = 0; j < superframes; j++) {
    const nf = Math.min(16, frames - j * 16);
    for (let c = 0; c < ch; c++) {
      let anchor = readBits(bits, p, 16); if (anchor >= 0x8000) anchor -= 0x10000;
      const mag = readBits(bits, p + 16, 8);
      p += 24;
      let pred = anchor;                              // predictor re-seed (s16 anchor)
      let idx = mag < 0 ? 0 : (mag > 88 ? 88 : mag);  // step-index seed
      for (let k = 0; k < nf; k++) {
        const row = offTab[readBits(bits, p, 8)];
        p += 8;
        const base = j * T00_SUPERFRAME + k * T00_FRAME;
        const n = Math.min(T00_FRAME, samples - base);
        let oi = base * ch + c;
        for (let t = 0; t < n; t++) {
          let code = readBits(bits, p, B);
          p += B;
          if (code >= half) code -= full;
          const step = stepTab[idx];
          if (code > 0) {
            pred += (step >> 1) + code * step;
            if (pred > 32767) pred = 32767;
            const d = idx + row[code >> shift];
            idx = d < 0 ? 0 : (d > 88 ? 88 : d);
          } else if (code < 0) {
            pred += code * step - (step >> 1);
            if (pred < -32768) pred = -32768;
            const d = idx + row[(-code) >> shift];
            idx = d < 0 ? 0 : (d > 88 ? 88 : d);
          } else {
            idx = idx > 0 ? idx - 1 : 0;
          }
          out[oi] = pred;
          oi += ch;
        }
      }
      if (p & 7) p += 8 - (p & 7); // pad the channel stream to a byte boundary
    }
  }
  const consumed = 8 + (p >> 3);
  if (consumed !== u8.length) throw new Error(`bslpc: consumed ${consumed} != size ${u8.length}`);
  return out;
}

// ---------------------------------------------------------------------------
// Type 0x01 — raw Opus packets (libopus 1.3.1 in-game; 20 ms CELT fullband stereo, 960
// samples @48 kHz, shorter final packet) behind a compact seek directory. Layout (BE):
//   off 8  u32  payload_start (= 12 + directory size, always ≡ 8 mod 36)
//   off 12      seek units, one per chunk of up to 16 packets:
//               u16[15] intra-chunk offsets of packets 1..15, u16 size of packet 15,
//               u32 absolute offset of the next chunk — omitted on the LAST unit (32 bytes).
//   payload_start.. Opus packets back to back, exactly tiling to EOF.

// -> { payloadStart, packets: [{ offset, length }] }   (full strict validation)
export function parseOpusDirectory(
  u8: Uint8Array,
): { payloadStart: number; packets: { offset: number; length: number }[] } {
  const size = u8.length;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const payload = dv.getUint32(8, false);
  const dirlen = payload - 12;
  if (dirlen < 32 || dirlen % 36 !== 32 || payload > size) {
    throw new Error(`opus: bad directory length ${dirlen}`);
  }
  const nunits = Math.floor(dirlen / 36) + 1;
  const packets: { offset: number; length: number }[] = [];
  let pos = 12, start = payload;
  for (let u = 0; u < nunits; u++) {
    const last = u === nunits - 1;
    const pk15Size = dv.getUint16(pos + 30, false);
    const next = last ? size : dv.getUint32(pos + 32, false);
    const chunkSize = next - start;
    const bounds = [0];
    for (let o = 0; o < 15; o++) {
      const off = dv.getUint16(pos + 2 * o, false);
      if (last && off === chunkSize) break; // end marker: final chunk holds < 16 packets
      if (off <= bounds[bounds.length - 1]) throw new Error(`opus: unit ${u} offsets not ascending`);
      bounds.push(off);
    }
    bounds.push(chunkSize);
    if (bounds.length === 17 && pk15Size !== bounds[16] - bounds[15]) {
      throw new Error(`opus: unit ${u} packet-15 size mismatch`);
    }
    if (bounds.length < 17 && (!last || pk15Size !== 0)) {
      throw new Error(`opus: unit ${u} short chunk before final unit`);
    }
    if (chunkSize <= 0 || bounds[bounds.length - 1] < bounds[bounds.length - 2]) {
      throw new Error(`opus: unit ${u} bad chunk bounds`);
    }
    for (let j = 0; j + 1 < bounds.length; j++) {
      packets.push({ offset: start + bounds[j], length: bounds[j + 1] - bounds[j] });
    }
    pos += last ? 32 : 36;
    start = next;
  }
  if (start !== size) throw new Error('opus: chunks do not tile to EOF');
  return { payloadStart: payload, packets };
}

// Port of libopus opus_pcm_soft_clip (src/opus.c, v1.6.1) for ONE deinterleaved channel.
// The int16 opus_decode() applies this before conversion (float API does not) — without it,
// clipped passages differ from libopus's int16 output by thousands of LSB. `x` is modified
// in place; returns the new declip memory `a` for the channel (carried across packets, like
// st->softclip_mem). Float32Array stores reproduce C's per-op float rounding closely enough
// (sub-LSB at int16 scale); `a` itself is computed with explicit fround.
function softClipChannel(x: Float32Array, a: number): number {
  const n = x.length;
  if (n < 1) return a;
  for (let i = 0; i < n; i++) {
    if (x[i] > 2) x[i] = 2; else if (x[i] < -2) x[i] = -2;
  }
  // continue the previous packet's non-linearity up to the first zero crossing
  for (let i = 0; i < n; i++) {
    if (x[i] * a >= 0) break;
    x[i] = x[i] + a * x[i] * x[i];
  }
  let curr = 0;
  const x0 = x[0];
  for (;;) {
    let i = curr;
    while (i < n && x[i] <= 1 && x[i] >= -1) i++;
    if (i === n) { a = 0; break; }
    let peakPos = i, start = i, end = i;
    let maxval = Math.abs(x[i]);
    while (start > 0 && x[i] * x[start - 1] >= 0) start--;
    while (end < n && x[i] * x[end] >= 0) {
      if (Math.abs(x[end]) > maxval) { maxval = Math.abs(x[end]); peakPos = end; }
      end++;
    }
    const special = start === 0 && x[i] * x[0] >= 0; // clipping before the first zero crossing
    // a such that maxval + a*maxval^2 = 1, boosted by 2^-22 against fast-math overshoot
    a = Math.fround(Math.fround(maxval - 1) / Math.fround(maxval * maxval));
    a = Math.fround(a + Math.fround(a * 2.4e-7));
    if (x[i] > 0) a = -a;
    for (let k = start; k < end; k++) x[k] = x[k] + a * x[k] * x[k];
    if (special && peakPos >= 2) {
      // linear ramp from the first sample to the peak to avoid a frame-start discontinuity
      let offset = Math.fround(x0 - x[0]);
      const delta = Math.fround(offset / peakPos);
      for (let k = curr; k < peakPos; k++) {
        offset = Math.fround(offset - delta);
        x[k] += offset;
        if (x[k] > 1) x[k] = 1; else if (x[k] < -1) x[k] = -1;
      }
    }
    curr = end;
    if (curr === n) break;
  }
  return a;
}

// celt FLOAT2INT16: scale by 32768, clamp, then lrintf (round half to EVEN — ties are real
// here: any float32 that is an odd multiple of 2^-16 scales to an exact .5).
function float2int16(v: number): number {
  v *= 32768;
  if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
  const q = Math.floor(v), r = v - q;
  if (r === 0.5) return q % 2 === 0 ? q : q + 1;
  return Math.round(v);
}

let opusModulePromise: Promise<any> | null = null; // lazy: only pulled in for type-01 objects

// Service workers forbid dynamic import(); sw.js statically imports the vendor
// and injects it here before first use.
export function preloadOpusModule(mod: any): void { opusModulePromise = Promise.resolve(mod); }

// -> Promise<Int16Array>, interleaved, trimmed to the header sample count (the tail of the
// last packet is padding; the ~312-sample pre-skip ramp is included in the count, not cut).
// The vendored WASM decoder is float; we replicate libopus's own int16 path on top of it
// (opus_pcm_soft_clip with carried memory, then FLOAT2INT16).
export async function decodeOpus(u8: Uint8Array): Promise<Int16Array> {
  const hdr = rawHeader(u8);
  if (hdr.codec !== 1) throw new Error(`not an opus object (codec=${hdr.codec})`);
  const ch = hdr.ch, samples = hdr.samples;
  const { packets } = parseOpusDirectory(u8);
  if (!opusModulePromise) opusModulePromise = import('../../vendor/opus-decoder.module.js');
  const { OpusDecoder } = await opusModulePromise;
  // 1 coupled stream + identity mapping == a plain stereo opus_decoder (what the game uses)
  const dec = new OpusDecoder({ channels: ch, streamCount: 1, coupledStreamCount: ch - 1 });
  await dec.ready;
  try {
    const out = new Int16Array(samples * ch);
    const declip = new Float64Array(ch);
    let wrote = 0; // decoded frames so far (per channel)
    for (const p of packets) {
      const { channelData, samplesDecoded, errors } =
        dec.decodeFrame(u8.subarray(p.offset, p.offset + p.length));
      if (errors.length) throw new Error(`opus: packet rejected (${errors[0].message})`);
      const n = Math.min(samplesDecoded, samples - wrote); // last packet's tail is padding
      for (let c = 0; c < ch; c++) {
        const src = channelData[c];
        // soft clip runs over the FULL decoded packet (state must see the padding tail too)
        declip[c] = softClipChannel(src, declip[c]);
        for (let i = 0, oi = wrote * ch + c; i < n; i++, oi += ch) out[oi] = float2int16(src[i]);
      }
      wrote += samplesDecoded;
      if (wrote >= samples) break;
    }
    if (wrote < samples) throw new Error(`opus: decoded ${wrote} < ${samples} samples`);
    return out;
  } finally {
    dec.free();
  }
}

// ---------------------------------------------------------------------------
// WAV writer — 44-byte canonical RIFF/PCM header (fmt 16, tag 1, 16-bit) +
// interleaved s16le data. Deterministic: byte-identical output for equal input.

export function encodeWav(pcm: Int16Array, ch: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  dv.setUint32(4, 36 + dataSize, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // 'WAVEfmt '
  dv.setUint32(16, 16, true);            // fmt chunk size
  dv.setUint16(20, 1, true);             // PCM
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * 2, true); // byte rate
  dv.setUint16(32, ch * 2, true);        // block align
  dv.setUint16(34, 16, true);            // bits/sample
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // 'data'
  dv.setUint32(40, dataSize, true);
  if (new Uint8Array(Int16Array.of(1).buffer)[0] === 1) {
    // little-endian host (every browser/Node target): the Int16Array IS the wire format
    bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataSize), 44);
  } else {
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + 2 * i, pcm[i], true);
  }
  return bytes;
}
