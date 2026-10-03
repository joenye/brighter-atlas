// An MP4 of H.264 video, written from the browser's own encoder's output (WebCodecs: each chunk one frame, the
// decoder configuration's description the avcC record): one track, every frame in one chunk, the index at the end.
// Enough for every player that plays an MP4; nothing else is needed for a short recording.

class Out {
  parts: Uint8Array[] = []; n = 0;
  bytes(b: Uint8Array) { this.parts.push(b); this.n += b.length; }
  u8(...v: number[]) { this.bytes(new Uint8Array(v)); }
  u16(v: number) { this.u8(v >> 8 & 255, v & 255); }
  u32(v: number) { this.u8(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255); }
  str(s: string) { this.u8(...[...s].map(c => c.charCodeAt(0))); }
  zeros(k: number) { this.bytes(new Uint8Array(k)); }
}
/** A box: its size, its type and what `fill` writes. */
function box(type: string, fill: (o: Out) => void): Uint8Array {
  const o = new Out(); fill(o);
  const b = new Uint8Array(8 + o.n), dv = new DataView(b.buffer);
  dv.setUint32(0, b.length); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  let at = 8; for (const p of o.parts) { b.set(p, at); at += p.length; }
  return b;
}
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

export class Mp4Writer {
  private samples: Uint8Array[] = [];
  private keys: number[] = [];
  private avcC: Uint8Array | null = null;
  constructor(private w: number, private h: number, private fps: number) {}
  /** One encoded frame (and, with the first, its decoder configuration). */
  add(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    if (!this.avcC && meta?.decoderConfig?.description) {
      const d = meta.decoderConfig.description as AllowSharedBufferSource;
      this.avcC = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer : d as ArrayBuffer);
    }
    const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
    this.samples.push(b);
    if (chunk.type === 'key') this.keys.push(this.samples.length);
  }
  /** The file. */
  finish(): Blob {
    const {w, h, samples} = this, scale = 90000, dur = Math.round(scale / this.fps), total = dur * samples.length;
    const ftyp = box('ftyp', o => { o.str('isom'); o.u32(0x200); o.str('isomiso2avc1mp41'); });
    const dataSize = samples.reduce((t, s) => t + s.length, 0);
    const mdatHead = new Uint8Array(8); new DataView(mdatHead.buffer).setUint32(0, 8 + dataSize); mdatHead.set([109, 100, 97, 116], 4);
    const dataAt = ftyp.length + 8;
    const full = (o: Out, version = 0, flags = 0) => o.u32(version << 24 | flags);
    const stbl = box('stbl', o => {
      o.bytes(box('stsd', o => { full(o); o.u32(1); o.bytes(box('avc1', o => {
        o.zeros(6); o.u16(1); o.zeros(16); o.u16(w); o.u16(h); o.u32(0x480000); o.u32(0x480000); o.u32(0); o.u16(1); o.zeros(32); o.u16(0x18); o.u16(0xffff);
        o.bytes(box('avcC', o => o.bytes(this.avcC ?? new Uint8Array(0))));
      })); }));
      o.bytes(box('stts', o => { full(o); o.u32(1); o.u32(samples.length); o.u32(dur); }));
      o.bytes(box('stss', o => { full(o); o.u32(this.keys.length); for (const k of this.keys) o.u32(k); }));
      o.bytes(box('stsc', o => { full(o); o.u32(1); o.u32(1); o.u32(samples.length); o.u32(1); }));
      o.bytes(box('stsz', o => { full(o); o.u32(0); o.u32(samples.length); for (const s of samples) o.u32(s.length); }));
      o.bytes(box('stco', o => { full(o); o.u32(1); o.u32(dataAt); }));
    });
    const moov = box('moov', o => {
      o.bytes(box('mvhd', o => { full(o); o.u32(0); o.u32(0); o.u32(scale); o.u32(total); o.u32(0x10000); o.u16(0x100); o.zeros(10); for (const m of MATRIX) o.u32(m); o.zeros(24); o.u32(2); }));
      o.bytes(box('trak', o => {
        o.bytes(box('tkhd', o => { full(o, 0, 3); o.u32(0); o.u32(0); o.u32(1); o.u32(0); o.u32(total); o.zeros(8); o.u16(0); o.u16(0); o.u16(0); o.u16(0); for (const m of MATRIX) o.u32(m); o.u32(w << 16); o.u32(h << 16); }));
        o.bytes(box('mdia', o => {
          o.bytes(box('mdhd', o => { full(o); o.u32(0); o.u32(0); o.u32(scale); o.u32(total); o.u16(0x55c4); o.u16(0); }));
          o.bytes(box('hdlr', o => { full(o); o.u32(0); o.str('vide'); o.zeros(12); o.str('Brighter Fashion'); o.u8(0); }));
          o.bytes(box('minf', o => {
            o.bytes(box('vmhd', o => { full(o, 0, 1); o.zeros(8); }));
            o.bytes(box('dinf', o => o.bytes(box('dref', o => { full(o); o.u32(1); o.bytes(box('url ', o => full(o, 0, 1))); }))));
            o.bytes(stbl);
          }));
        }));
      }));
    });
    return new Blob([ftyp, mdatHead, ...samples, moov] as BlobPart[], {type: 'video/mp4'});
  }
}

/** The H.264 profile and level a size and rate need (High; level 4.0 up to 1080p30, 4.2 to 1080p60, 5.1 beyond). */
export function avcCodec(w: number, h: number, fps: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16), rate = mbs * fps;
  const level = mbs <= 8192 && rate <= 245760 ? '28' : mbs <= 8704 && rate <= 522240 ? '2a' : '33';
  return `avc1.6400${level}`;
}
