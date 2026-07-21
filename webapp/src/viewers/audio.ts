// Audio player: WebAudio decode -> min/max waveform, click-seek, loop, rate.
// Codec badges: all three decode exactly — qoa, opus, and type-00 "bslpc" ADPCM.

import { el, append, badge, fmtInt, fmtDur, notExported, idLabel } from '../ui.js';
import { addExportButton } from '../asset-export.js';
import type { IndexEntry } from '../store.js';

let _ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!_ctx) _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return _ctx;
}

const CODEC_INFO: Record<string, [string, string]> = {
  qoa: ['b-good', 'QOA audio'],
  opus: ['b-good', 'Opus audio'],
  bslpc: ['b-good', 'Sound effect (the game’s built-in effect format)'],
};

export function createAudioView(app: any, entry: IndexEntry) {
  const root = el('div', { class: 'viewer-pane' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  const waveWrap = el('div', { class: 'audio-wave-wrap' });
  const statsRow = el('div', { class: 'stats-row' });
  root.append(toolbar, waveWrap, statsRow);

  const [cls, tip] = CODEC_INFO[entry.codec] || ['', ''];
  const codecLabel = entry.codec === 'bslpc' ? 'SFX' : entry.codec;
  append(toolbar,
    el('span', { class: 'viewer-title', text: `Audio ${idLabel(entry)}` }),
    badge(`#${entry.i}`, 'b-ghost', 'Where this asset sits in the game files. The id in the title is its permanent name and never changes.'),
    badge(codecLabel, cls, tip),
  );

  statsRow.append(
    el('span', {}, 'duration ', el('b', { text: fmtDur(entry.dur) })),
    el('span', {}, 'channels ', el('b', { text: String(entry.ch) })),
    el('span', {}, 'sample rate ', el('b', { text: `${fmtInt(entry.sr)} Hz` })),
    el('span', {}, 'samples ', el('b', { text: fmtInt(entry.n) })),
  );

  let destroyed = false;
  let source: AudioBufferSourceNode | null = null, buffer: AudioBuffer | null = null;
  let playing = false, startCtxTime = 0, startOffset = 0, rate = 1, loop = false;
  let pendingPlay = false;   // Space pressed before decode finished -> play on load
  let raf = 0;

  const view: { root: HTMLDivElement; destroy(): void; togglePlay?: () => void } = {
    root,
    destroy() {
      destroyed = true;
      stopSource();
      cancelAnimationFrame(raf);
    },
  };

  if (!entry.f) {
    waveWrap.replaceWith(el('div', { style: 'flex:1' }, notExported(`Audio #${entry.i}`)));
    return view;
  }

  const canvas = el('canvas');
  waveWrap.appendChild(canvas);

  const playBtn = el('button', { class: 'btn', text: '▶', disabled: true });
  const loopBtn = el('button', { class: 'btn', text: '⟳', title: 'Loop' });
  const rateSel = el('select', { class: 'btn', title: 'Playback rate' });
  for (const r of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]) rateSel.appendChild(el('option', { value: String(r), text: `${r}×`, selected: r === 1 }));
  const timeLbl = el('span', { class: 'anim-time', text: '0.00s' });
  toolbar.append(el('span', { class: 'sep' }), playBtn, loopBtn, rateSel, timeLbl);
  addExportButton(toolbar, app, 'audio', entry);

  function stopSource(): void {
    if (source) {
      try { source.onended = null; source.stop(); } catch { /* not started */ }
      source.disconnect();
      source = null;
    }
  }

  function curPos(): number {
    if (!buffer) return 0;
    if (!playing) return startOffset;
    let p = startOffset + (audioCtx().currentTime - startCtxTime) * rate;
    if (loop) p %= buffer.duration;
    return Math.min(p, buffer.duration);
  }

  function playFrom(offset: number): void {
    stopSource();
    const ctx = audioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = rate;
    source.connect(ctx.destination);
    source.onended = () => {
      if (!loop && playing) { playing = false; startOffset = 0; playBtn.textContent = '▶'; }
    };
    source.start(0, Math.min(offset, Math.max(0, buffer!.duration - 1e-4)));
    startCtxTime = ctx.currentTime;
    startOffset = offset;
    playing = true;
    playBtn.textContent = '❚❚';
  }

  function pause(): void {
    startOffset = curPos();
    stopSource();
    playing = false;
    playBtn.textContent = '▶';
  }

  // Toggle playback of this track. Exposed on the view so the asset list can
  // drive it from the keyboard (Space/Enter) for a fast preview workflow. If the
  // buffer hasn't decoded yet, remember the intent and honor it on load.
  view.togglePlay = () => {
    if (!buffer) { pendingPlay = !pendingPlay; return; }
    if (playing) pause();
    else playFrom(startOffset >= buffer.duration - 1e-4 ? 0 : startOffset);
  };
  playBtn.addEventListener('click', () => view.togglePlay!());
  loopBtn.addEventListener('click', () => {
    loop = !loop;
    loopBtn.classList.toggle('active', loop);
    if (source) source.loop = loop;
  });
  rateSel.addEventListener('change', () => {
    const newRate = parseFloat(rateSel.value);
    if (playing) { const p = curPos(); rate = newRate; playFrom(p); }
    else rate = newRate;
  });
  canvas.addEventListener('click', (e) => {
    if (!buffer) return;
    const frac = e.offsetX / canvas.clientWidth;
    const p = frac * buffer.duration;
    if (playing) playFrom(p);
    else { startOffset = p; drawAll(); }
  });

  // ---- waveform ------------------------------------------------------------
  let peaks: Float32Array | null = null; // [ [min,max] per column ] for channel 0 (+1 merged)
  function computePeaks(width: number): void {
    const ch0 = buffer!.getChannelData(0);
    const ch1 = buffer!.numberOfChannels > 1 ? buffer!.getChannelData(1) : null;
    const cols = Math.max(64, width);
    const per = ch0.length / cols;
    peaks = new Float32Array(cols * 2);
    for (let c = 0; c < cols; c++) {
      let mn = 1, mx = -1;
      const s0 = Math.floor(c * per), s1 = Math.min(ch0.length, Math.max(s0 + 1, Math.floor((c + 1) * per)));
      const step = Math.max(1, Math.floor((s1 - s0) / 512));
      for (let s = s0; s < s1; s += step) {
        let v = ch0[s];
        if (ch1) v = (v + ch1[s]) * 0.5;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      peaks[c * 2] = mn; peaks[c * 2 + 1] = mx;
    }
  }

  function drawAll(): void {
    if (!buffer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = waveWrap.clientWidth, h = waveWrap.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; computePeaks(w); }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0d0f13';
    g.fillRect(0, 0, w, h);
    const mid = h / 2, amp = h * 0.46;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
    const cols = peaks!.length / 2;
    const pos = curPos() / buffer.duration;
    for (let c = 0; c < cols; c++) {
      const x = (c / cols) * w;
      g.fillStyle = (c / cols) <= pos ? '#78b7ff' : '#33415a';
      const mn = peaks![c * 2], mx = peaks![c * 2 + 1];
      const y0 = mid - mx * amp, y1 = mid - mn * amp;
      g.fillRect(x, y0, Math.max(1, w / cols - 0.5), Math.max(1, y1 - y0));
    }
    // playhead
    g.fillStyle = '#e8ecf2';
    g.fillRect(pos * w - 0.5, 0, 1.5, h);
    timeLbl.textContent = `${fmtDur(curPos())} / ${fmtDur(buffer.duration)}`;
  }

  function tick(): void {
    if (destroyed) return;
    drawAll();
    raf = requestAnimationFrame(tick);
  }

  (async () => {
    try {
      const ab = await app.store.arrayBuffer(entry.f);
      if (destroyed) return;
      buffer = await audioCtx().decodeAudioData(ab);
      if (destroyed) return;
      playBtn.disabled = false;
      computePeaks(waveWrap.clientWidth || 800);
      tick();
      if (pendingPlay) { pendingPlay = false; view.togglePlay!(); }
      app.setStatus3(`audio #${entry.i} · ${codecLabel} · ${fmtDur(buffer.duration)}`);
    } catch (e) {
      if (!destroyed) waveWrap.appendChild(el('div', { class: 'notexported' }, badge('decode failed', 'b-bad'), el('div', { class: 'small dim', text: String(e.message || e) })));
    }
  })();

  return view;
}
