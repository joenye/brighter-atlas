// Video wizard for the skeleton composite: exports MP4 / WEBM / animated GIF.
// Native MP4 + WEBM record the live composite in real time via MediaRecorder;
// GIF and the software-MP4 fallback (vendored h264-mp4-encoder, for Firefox)
// are rendered OFFLINE: the animation clock steps exactly 1/fps per frame and
// each frame is rendered + read back deterministically, so the output is
// perfectly paced regardless of scene cost (recording just isn't real-time).
// The composite (source canvas + optional caption bar) is drawn every frame
// into a canvas shown in the modal.
//
// The preview is INDEPENDENT of the main editor: it drives its own ClipSampler
// (its own play/pause/speed/restart), so nothing here changes the editor's
// transport. The main editor's transport is paused while the modal is open and
// restored to its exact prior state on close.
//
// Options: multiple animations (back to back), loops per clip, playback speed,
// turntable rotation, resolution (presets or custom W×H), caption (full
// override), grid + background. All settings persist in storage.

import { el } from '../ui.js';
import { effectiveName } from '../names.js';
import { encodeGif } from './gif-encoder.js';
import { ClipSampler, SPEEDS } from './rig.js';
import { sceneOverrides, drawComposite, drawCaption, renderCaptureFrame, makeCropOverlay, makeCaptionControls, attachCaptionDrag, attachPreviewOrbit, settingsStore } from './capture-common.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const store = settingsStore('bs.videoWizard');

export function openVideoWizard({ app, scene, bar, clips, entry, activeSize }:
  { app: any; scene: any; bar: any; clips: any[]; entry: any; activeSize: number }): void {
  const rig = bar?.rig ?? null;   // shared rig; null for a static scene (e.g. a room)
  const hasClips = clips.length > 0;
  const src: HTMLCanvasElement = scene.renderer.domElement;   // the composite reads this every frame
  // MP4 first so it's the default wherever the browser can record it; WebM is the
  // fallback. Both are always SHOWN (disabled in the dropdown when this browser
  // can't record them) so it's clear which formats exist. GIF is always available
  // (encoded in-app), just heavier.
  const mimes: [string, string | null][] = ([
    ['mp4', ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.4D401E', 'video/mp4;codecs=avc1', 'video/mp4']],
    ['webm', ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']],
  ] as [string, string[]][]).map(([label, cands]) => [label, (window.MediaRecorder ? cands.find((m) => MediaRecorder.isTypeSupported(m)) : null) ?? null]);
  const nativeMp4 = mimes.find(([l]) => l === 'mp4')?.[1] || null;   // MediaRecorder mp4 mime, if any
  // mp4 is ALWAYS available: native MediaRecorder where supported, else the
  // vendored software H.264 encoder (works in Firefox). WebM is native-only.
  const canRecord = (f: string) => f === 'gif' || f === 'mp4' || mimes.some(([label, m]) => label === f && m);
  const formats = [...mimes.map(([label]) => label), 'gif'];   // all shown; unsupported are disabled

  // one source of truth for the recorder AND the live size estimate
  const VIDEO_BPS = 10_000_000;    // MediaRecorder target bitrate (video only, no audio track)
  const WASM_MP4_BPS = 8_000_000;  // software H.264 fallback target bitrate (Firefox etc.)
  const WASM_MP4_FPS = 30;         // frame-capture rate for the software MP4 encoder
  const GIF_FPS = 25;              // default; 40ms = exact 4-centisecond GIF delay
  const GIF_MAXW = 1600;           // safety ceiling for the synchronous GIF encoder
  const GIF_BYTES_PER_PX = 0.15;   // measured post-LZW bytes/pixel (more for busy/textured frames)

  const saved = store.load();
  const ov = sceneOverrides(scene);   // grid/background overrides, restored on close

  const overlay = el('div', { class: 'modal-overlay' });   // normal dimmed backdrop: the app stays visible behind the modal
  let closed = false;
  let abortRec: (() => void) | null = null;   // set while recording; close() calls it to stop cleanly
  const close = () => { closed = true; abortRec?.(); overlay.remove(); cleanupPreview(); ov.restore(); restoreEditor(); };
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  // ---- controls -------------------------------------------------------------
  const fmtSel = el('select', { class: 'btn' });
  for (const f of formats) {
    const off = !canRecord(f);
    const hint = f === 'gif' ? ' (short loops, larger file)'
      : (f === 'mp4' && !nativeMp4) ? ' (slower)'
      : off ? ' (not supported by this browser)' : '';
    fmtSel.appendChild(el('option', { value: f, disabled: off, text: f.toUpperCase() + hint }));
  }
  // default: the saved format if this browser can record it, else the first
  // recordable one (MP4 when available, then WebM, then GIF).
  fmtSel.value = (saved.fmt && canRecord(saved.fmt)) ? saved.fmt : formats.find(canRecord)!;
  const fmtHint = el('span', { class: 'dim small' });   // explains why WebM/MP4 are disabled while transparent

  // GIF frame rate. GIF delays are whole centiseconds, so only these rates play
  // back exactly (50fps = 2cs is the format's ceiling: 1cs delays get clamped
  // to 100ms by most decoders). Frames are rendered OFFLINE (the clock steps
  // exactly 1/fps per frame), so every frame is captured at any resolution.
  // Recording just takes longer than real time on heavy scenes.
  const GIF_RATES: [string, string][] = [['10', '10'], ['20', '20'], ['25', '25 (default)'], ['33.333', '33'], ['50', '50 (max)']];
  const gifFpsSel = el('select', {
    class: 'btn',
    title: 'GIF frames per second (50 is the GIF format\'s hard maximum). Frames are rendered one by one, so every frame is captured even on heavy scenes. Higher fps is smoother but records slower and makes a larger file.',
  });
  for (const [v, label] of GIF_RATES) gifFpsSel.appendChild(el('option', { value: v, text: `${label} fps` }));
  gifFpsSel.value = GIF_RATES.some(([v]) => v === String(saved.gifFps)) ? String(saved.gifFps) : String(GIF_FPS);
  const gifFps = () => parseFloat(gifFpsSel.value) || GIF_FPS;
  const gifFpsWrap = el('span', {}, el('span', { class: 'sep-mini' }), gifFpsSel);
  const syncGifFpsVis = () => { gifFpsWrap.style.display = fmtSel.value === 'gif' ? '' : 'none'; };
  gifFpsSel.addEventListener('change', () => saveSettings());
  fmtSel.addEventListener('change', syncGifFpsVis);
  syncGifFpsVis();

  const clipSel = el('select', { class: 'btn video-clips', multiple: true, size: '6', title: 'Which animations to record (multi-select: Ctrl/Shift-click). They play back to back' });
  for (const c of clips) {
    if (!c.f) continue;
    const nm = effectiveName(c, 'anims');
    clipSel.appendChild(el('option', { value: String(c.i), text: `#${c.i}${nm ? ` · ${nm}` : ''} · ${(c.dur / 1000).toFixed(2)}s` }));
  }
  if (bar?.sampler) { const o = [...clipSel.options].find((x) => x.value === String(bar.sampler.index)); if (o) o.selected = true; }
  else if (clipSel.options.length) clipSel.options[0].selected = true;
  // no clips (World/room view): a Duration control sets the turntable run length
  const durIn = el('input', { type: 'number', min: '1', max: '60', step: '1', class: 'video-dim', value: String(saved.roomDur || 6), title: 'Recording length in seconds' });
  const durSecs = () => Math.max(1, Math.min(60, parseInt(durIn.value, 10) || 6));

  const loopsIn = el('input', { type: 'number', min: '1', max: '10', value: String(saved.loops || 1) });

  // playback speed (same set as the main editor)
  const speedSel = el('select', { class: 'btn', title: 'Preview + recording speed' });
  let previewSpeed = SPEEDS.includes(saved.speed) ? saved.speed : 0.5;   // match the viewer's 0.5× default (in-game "1×")
  for (const s of SPEEDS) speedSel.appendChild(el('option', { value: String(s), text: `${s}×`, selected: s === previewSpeed }));
  speedSel.addEventListener('change', () => { previewSpeed = parseFloat(speedSel.value); saveSettings(); });

  // hold the last frame for N seconds at the end (so non-looping animations
  // don't snap straight back to the start when a GIF loops)
  const holdIn = el('input', { type: 'number', min: '0', max: '5', step: '0.5', class: 'video-dim', title: 'Seconds to hold the final frame before looping', value: String(saved.holdEnd ?? 0) });

  const rotCb = el('input', { type: 'checkbox' });
  rotCb.checked = saved.rot !== false;
  // two ways to drive the turntable: a raw angular speed, or "N rotations, S
  // seconds each": the latter also sets the recording length (see buildSegs),
  // so you get an exact whole number of clean orbits.
  const rotModeSel = el('select', { class: 'btn', title: 'Turntable timing: a fixed angular speed, or a number of full rotations at a set seconds-per-rotation (which also sets the recording length)' });
  for (const [v, label] of [['speed', 'speed'], ['rotations', 'rotations']]) rotModeSel.appendChild(el('option', { value: v, text: label }));
  rotModeSel.value = saved.rotMode === 'rotations' ? 'rotations' : 'speed';
  const rotSpeed = el('input', { type: 'range', min: '6', max: '360', value: String(saved.rotSpeed || 30) });
  const rotLbl = el('span', { class: 'mono dim small', text: `${rotSpeed.value}°/s` });
  rotSpeed.addEventListener('input', () => { rotLbl.textContent = `${rotSpeed.value}°/s`; });
  // rotations mode: seconds per full turn × number of turns = the whole take
  const secPerRotIn = el('input', { type: 'number', min: '1', max: '120', step: '0.5', class: 'video-dim', title: 'Seconds for one full rotation', value: String(saved.secPerRot || 6) });
  const numRotIn = el('input', { type: 'number', min: '0.5', max: '20', step: '0.5', class: 'video-dim', title: 'How many full rotations to record', value: String(saved.numRot || 2) });
  const rotTotalLbl = el('span', { class: 'mono dim small' });
  const secPerRot = () => Math.max(1, Math.min(120, parseFloat(secPerRotIn.value) || 6));
  const numRot = () => Math.max(0.5, Math.min(20, parseFloat(numRotIn.value) || 2));
  const rotDrivesLength = () => rotCb.checked && rotModeSel.value === 'rotations';
  const turntableDurationMs = () => secPerRot() * numRot() * 1000;
  // effective angular speed for both record paths (°/s); in rotations mode it
  // derives from seconds-per-rotation so N turns land exactly on N.
  const degPerSec = () => (rotModeSel.value === 'rotations' ? 360 / secPerRot() : (parseInt(rotSpeed.value, 10) || 30));
  const rotSpeedWrap = el('span', {}, rotSpeed, el('span', { class: 'sep-mini' }), rotLbl);
  const rotCountWrap = el('span', {}, secPerRotIn, el('span', { class: 'dim small', text: ' s/turn' }),
    el('span', { class: 'sep-mini' }), el('span', { class: 'dim small', text: '×' }), numRotIn,
    el('span', { class: 'dim small', text: ' turns' }), el('span', { class: 'sep-mini' }), rotTotalLbl);
  // duration/loops labels are governed by rotations mode; assigned when the form
  // is built below, toggled by syncRotUI.
  let durLabel: any = null, loopsWrap: any = null;
  const syncRotTotal = () => { rotTotalLbl.textContent = `= ${(secPerRot() * numRot()).toFixed(1)}s`; };
  function syncRotUI(): void {
    const on = rotCb.checked;
    const asTurns = on && rotModeSel.value === 'rotations';
    rotModeSel.style.display = on ? '' : 'none';
    rotSpeedWrap.style.display = on && !asTurns ? '' : 'none';
    rotCountWrap.style.display = asTurns ? '' : 'none';
    if (durLabel) durLabel.style.display = asTurns ? 'none' : '';   // rotations own the length
    if (loopsWrap) loopsWrap.style.display = asTurns ? 'none' : '';
    syncRotTotal();
  }
  rotModeSel.addEventListener('change', () => { syncRotUI(); saveSettings(); });
  secPerRotIn.addEventListener('input', () => { syncRotTotal(); saveSettings(); });
  numRotIn.addEventListener('input', () => { syncRotTotal(); saveSettings(); });
  rotCb.addEventListener('change', syncRotUI);

  // resolution: presets or custom W×H (aspect-locked to the scene). A live
  // readout shows the exact output pixels before you record.
  const resSel = el('select', { class: 'btn' });
  for (const [v, label] of [['1', 'full'], ['0.75', '75%'], ['0.5', '50%'], ['custom', 'custom…']]) resSel.appendChild(el('option', { value: v, text: `resolution: ${label}` }));
  if (saved.scale) resSel.value = saved.scale;
  const wIn = el('input', { type: 'number', min: '16', max: '4096', step: '2', class: 'video-dim', title: 'Output width (px)' });
  const hIn = el('input', { type: 'number', min: '16', max: '4096', step: '2', class: 'video-dim', title: 'Output height (px)' });
  const dimsLbl = el('span', { class: 'mono dim small' });
  const sizeLbl = el('span', { class: 'mono dim small', title: 'Estimated output file size' });
  const aspect = () => (src.width && src.height ? src.width / src.height : 16 / 9);
  const customWrap = el('span', { class: 'video-custom' }, wIn, el('span', { class: 'dim small', text: '×' }), hIn, el('span', { class: 'dim small', text: 'px' }));
  const syncCustomVis = () => { customWrap.style.display = resSel.value === 'custom' ? '' : 'none'; };
  // seed the custom fields from the current output the first time custom is picked
  let customSeeded = false;
  const seedCustom = () => {
    if (customSeeded || !src.width) return;
    customSeeded = true;
    const w = saved.customW || src.width;
    wIn.value = String(Math.round(w) & ~1);
    hIn.value = String(Math.round((saved.customH || (w / aspect()))) & ~1);
  };
  wIn.addEventListener('input', () => { hIn.value = String(Math.max(2, Math.round((parseInt(wIn.value, 10) || 0) / aspect())) & ~1); saveSettings(); });
  hIn.addEventListener('input', () => { wIn.value = String(Math.max(2, Math.round((parseInt(hIn.value, 10) || 0) * aspect())) & ~1); saveSettings(); });
  resSel.addEventListener('change', () => { if (resSel.value === 'custom') seedCustom(); syncCustomVis(); saveSettings(); });
  if (resSel.value === 'custom') seedCustom();   // restore persisted custom size
  syncCustomVis();

  const capCb = el('input', { type: 'checkbox' });
  capCb.checked = saved.caption !== false;
  const capIn = el('input', { type: 'text', class: 'video-cap', placeholder: 'caption text…' });
  // default caption = the model name; the field is the FULL caption (edits fully
  // replace it: the clip name is never force-appended).
  capIn.value = saved.captionText ?? (effectiveName(entry, 'rigs') || `Rig #${entry.i}`);
  capIn.addEventListener('input', saveSettings);
  const capStyle = makeCaptionControls(saved.captionStyle, () => saveSettings());   // font/size/bg/reset (drag attached below)
  const capOpts = () => (capCb.checked && capIn.value ? { text: capIn.value, ...capStyle.style } : '');

  // grid + background overrides (applied live to the scene, restored on close)
  const gridCb = el('input', { type: 'checkbox', disabled: !ov.hasGrid });
  gridCb.checked = ov.hasGrid && (saved.grid ?? ov.gridVisible);
  const bgIn = el('input', { type: 'color', value: saved.bg || ov.bgHex });
  const bgDefBtn = el('button', { class: 'btn btn-mini', text: 'default', title: 'Reset the background to the viewer default' });
  const transpCb = el('input', { type: 'checkbox', title: 'Transparent background: GIF only (video files can’t be transparent)' });
  transpCb.checked = !!saved.transparent;

  // Only GIF can carry alpha here; force it + disable the video formats while
  // transparent (restoring their normal can-record state when unchecked).
  const syncFmt = () => {
    for (const o of fmtSel.options) {
      if (o.value === 'gif') continue;
      o.disabled = transpCb.checked || !canRecord(o.value);
      o.title = transpCb.checked ? 'A transparent background can only be saved as GIF (video files can’t be transparent)' : '';
    }
    if (transpCb.checked && fmtSel.value !== 'gif') fmtSel.value = 'gif';
    fmtHint.textContent = transpCb.checked ? '· transparent → GIF only' : '';
    syncGifFpsVis();
  };
  const applyBg = () => {
    ov.setGrid(gridCb.checked);
    if (!transpCb.checked) ov.setBackground(bgIn.value);   // background colour is moot when transparent
    bgIn.disabled = bgDefBtn.disabled = transpCb.checked;
  };
  applyBg();
  syncFmt();
  const applyView = () => { applyBg(); syncFmt(); saveSettings(); };
  gridCb.addEventListener('change', applyView);
  bgIn.addEventListener('input', applyView);
  transpCb.addEventListener('change', applyView);
  bgDefBtn.addEventListener('click', () => { bgIn.value = ov.defaultBg; applyView(); });

  // hoisted (function declaration) so the many listeners above that reference it
  // resolve regardless of definition order. It only runs on user interaction.
  function saveSettings(): void {
    store.save({
      fmt: fmtSel.value, loops: loopsIn.value, speed: previewSpeed, rot: rotCb.checked, rotSpeed: rotSpeed.value,
      rotMode: rotModeSel.value, secPerRot: secPerRotIn.value, numRot: numRotIn.value,
      scale: resSel.value, customW: parseInt(wIn.value, 10) || null, customH: parseInt(hIn.value, 10) || null,
      caption: capCb.checked, captionText: capIn.value, grid: gridCb.checked, bg: bgIn.value,
      transparent: transpCb.checked, holdEnd: parseFloat(holdIn.value) || 0, gifFps: gifFpsSel.value,
      cropL: crop.cropL, cropR: crop.cropR, captionStyle: { ...capStyle.style },
    });
  }
  for (const c of [fmtSel, loopsIn, rotCb, rotSpeed, capCb, holdIn]) c.addEventListener('change', saveSettings);

  const status = el('p', { class: 'dim small', text: `Preview plays the selected animation; it is exactly what gets recorded (${activeSize} mesh${activeSize === 1 ? '' : 'es'}).` });

  // ---- live composite (shown directly) --------------------------------------
  const comp = el('canvas', { class: 'video-preview' });
  const cctx = comp.getContext('2d')!;

  // ---- width crop: draggable vertical guides trim empty side bars ------------
  // Shared overlay; the cropped slice is mirrored into cropCanvas each frame,
  // which every capture path reads from.
  const crop = makeCropOverlay(comp, { cropL: saved.cropL, cropR: saved.cropR, onChange: (committed) => { if (committed) saveSettings(); } });
  attachCaptionDrag(comp, () => (capCb.checked ? capIn.value : ''), capStyle.style, () => saveSettings());
  const cropWrap = crop.wrap;
  const cropCanvas = el('canvas');
  const cropCtx = cropCanvas.getContext('2d')!;
  const updateCropCanvas = () => {   // mirror the cropped slice of `comp` (each frame after paint)
    const { x, w, h } = crop.rect();
    if (cropCanvas.width !== w || cropCanvas.height !== h) { cropCanvas.width = w; cropCanvas.height = h; }
    if (comp.width) cropCtx.drawImage(comp, x, 0, w, h, 0, 0, w, h);
  };
  // extract columns [x0, x0+cw) from a straight-alpha RGBA buffer (transparent crop)
  const cropRGBA = (data: Uint8ClampedArray, w: number, h: number, x0: number, cw: number) => {
    const out = new Uint8ClampedArray(cw * h * 4);
    for (let y = 0; y < h; y++) out.set(data.subarray((y * w + x0) * 4, (y * w + x0 + cw) * 4), y * cw * 4);
    return out;
  };

  // interactive framing: drag the preview to orbit, wheel to zoom (shared with
  // the screenshot modal). Whatever the user frames here is what the recording
  // captures: the zoom is preserved, and with turntable on it becomes the
  // starting angle. Disposed on close.
  const previewOrbit = attachPreviewOrbit(comp, scene);

  const currentScale = () => {
    if (resSel.value === 'custom') {
      const cw = Math.max(16, Math.min(4096, parseInt(wIn.value, 10) || src.width || 2));
      return src.width ? cw / src.width : 1;
    }
    return parseFloat(resSel.value);
  };
  // the segments the recorder plays and their real-time lengths. Per clip =
  // duration × loops ÷ speed (min 300ms). In rotations mode the turntable owns
  // the length (N turns × S seconds), so we fill that window instead: no clips →
  // one static segment; with clips → the queue repeated to fill, the final
  // segment trimmed so it lands exactly on the last frame.
  const buildSegs = (): { clip: any; ms: number }[] => {
    const queue = [...clipSel.selectedOptions].map((o) => clips.find((c) => c.i === +o.value)).filter(Boolean);
    const loops = Math.max(1, Math.min(10, parseInt(loopsIn.value, 10) || 1));
    if (!queue.length) return [{ clip: null, ms: rotDrivesLength() ? turntableDurationMs() : durSecs() * 1000 }];
    const segLoops = rotDrivesLength() ? 1 : loops;   // rotations mode loops the clip to fill, not by count
    const natural = queue.map((c) => ({ clip: c, ms: Math.max(300, (c.dur * segLoops) / previewSpeed) }));
    if (!rotDrivesLength()) return natural;
    const target = turntableDurationMs();
    const segs: { clip: any; ms: number }[] = [];
    for (let i = 0, acc = 0; acc < target - 1 && i < 10000; i++) {
      const base = natural[i % natural.length];
      const ms = Math.min(base.ms, target - acc);
      if (ms < 1) break;
      segs.push({ clip: base.clip, ms });
      acc += ms;
    }
    return segs.length ? segs : natural;
  };
  // real-time duration of the recording (mirrors buildSegs); default from the
  // no-clip / Duration path when nothing is selected.
  const estDurationMs = (floored: boolean) =>
    buildSegs().reduce((a, s) => a + (floored ? Math.max(300, s.ms) : s.ms), 0);
  // estimated output bytes. GIF + software-MP4 capture discrete frames and are
  // trimmed to exactly `loops` iterations, so their size follows the UNfloored
  // animation duration; native WebM/MP4 (MediaRecorder) record the full floored
  // wall-clock at ~VIDEO_BPS. GIF ≈ frames × pixels × a rough LZW factor.
  const estimateBytes = (w: number, h: number) => {
    const fmt = fmtSel.value;
    const frameCap = fmt === 'gif' || (fmt === 'mp4' && !nativeMp4);
    // GIF holds via a longer last-frame delay (negligible bytes); video formats
    // append/record the held frame, so it adds to their duration.
    const holdSec = fmt === 'gif' ? 0 : Math.max(0, Math.min(5, parseFloat(holdIn.value) || 0));
    const secs = estDurationMs(!frameCap) / 1000 + holdSec;
    if (fmt === 'gif') {
      const gw = Math.min(GIF_MAXW, w) & ~1;
      const gh = w ? (Math.round(gw * (h / w)) & ~1) : gw;
      return Math.max(1, Math.round(secs * gifFps())) * gw * gh * GIF_BYTES_PER_PX;
    }
    const bps = (fmt === 'mp4' && !nativeMp4) ? WASM_MP4_BPS : VIDEO_BPS;
    return bps * secs / 8;
  };
  const fmtSize = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

  const paint = () => {
    if (resSel.value === 'custom' && !customSeeded && src.width) seedCustom();   // seed once the canvas has a size
    const { h } = drawComposite(cctx, comp, src, {
      scale: currentScale(),
      caption: capOpts(),
      transparent: transpCb.checked, scene3d: scene, preview: true,
    });
    updateCropCanvas();
    const cw = crop.rect().w;   // output width is the cropped width
    dimsLbl.textContent = `${cw} × ${h}px`;
    sizeLbl.textContent = `≈ ${fmtSize(estimateBytes(cw, h))}${fmtSel.value === 'gif' ? ' (rough)' : ''}`;
  };
  let rafId = 0, lastPaint = 0;
  const compositeLoop = () => {
    if (closed) return;
    // While a transparent recording runs, the capture timer already re-renders
    // the scene + reads it back per frame; painting this monitor at full rAF
    // rate doubles that GPU/readback work and starves the capture loop. Drop
    // the monitor to ~8fps for the duration (opaque + MediaRecorder formats
    // need the full-rate paint: they record FROM the composite/crop canvas).
    const throttle = abortRec && transpCb.checked;
    const now = performance.now();
    if (!throttle || now - lastPaint >= 125) { paint(); lastPaint = now; }
    rafId = requestAnimationFrame(compositeLoop);
  };
  compositeLoop();
  function cleanupPreview(): void { cancelAnimationFrame(rafId); previewOrbit.dispose(); }

  // ---- INDEPENDENT preview playback -----------------------------------------
  // The preview owns its own ClipSampler and playback state; it applies poses to
  // the shared rig via a dedicated scene tick. The main editor's transport is
  // paused while we're open and restored on close, so nothing here leaks into it.
  const editorRestore = {
    value: bar?.select?.value ?? null, playing: bar?.playing ?? false, loop: bar?.loop ?? false, t: bar?.t ?? 0,
    // the modal's orbit moves the SHARED camera; capture the editor's framing so
    // closing restores it (the modal preview no longer disturbs the main view).
    camPos: scene.camera.position.clone(), camUp: scene.camera.up.clone(), camTarget: scene.controls.target.clone(),
  };
  bar?.pause();

  let previewSampler: any = null, previewT = 0, previewPlaying = true, previewLoop = true, previewGen = 0;
  const stopPreviewTick = scene.addTick((dt: number) => {
    if (!previewPlaying || !previewSampler || !rig) return;
    const dur = Math.max(1, previewSampler.duration);
    previewT += dt * previewSpeed;
    if (previewT > dur) previewT = previewLoop ? (dur > 0 ? previewT % dur : 0) : dur;
    previewSampler.apply(rig, previewT);
  });

  const firstSelected = () => [...clipSel.selectedOptions].map((o) => clips.find((c) => c.i === +o.value)).find(Boolean);
  const prevBtn = el('button', { class: 'btn', text: '❚❚', title: 'Play / pause the preview' });
  const restartBtn = el('button', { class: 'btn', text: '↻', title: 'Restart the preview from the first frame' });
  // generation token: a slower async load must never clobber a newer selection
  async function loadPreview(clip: any): Promise<void> {
    const gen = ++previewGen;
    if (!clip?.f) { previewSampler = null; previewPlaying = false; prevBtn.textContent = '▶'; return; }
    try {
      const json = await app.store.payload(clip.f);
      if (gen !== previewGen) return;   // superseded
      previewSampler = new ClipSampler(json);
      previewT = 0; previewLoop = true; previewPlaying = true;
      prevBtn.textContent = '❚❚';
    } catch { if (gen === previewGen) previewSampler = null; }
  }
  prevBtn.addEventListener('click', () => {
    if (!previewSampler) { loadPreview(firstSelected()); return; }
    previewPlaying = !previewPlaying;
    prevBtn.textContent = previewPlaying ? '❚❚' : '▶';
  });
  restartBtn.addEventListener('click', () => { previewT = 0; if (previewSampler) { previewPlaying = true; prevBtn.textContent = '❚❚'; } });
  clipSel.addEventListener('change', () => loadPreview(firstSelected()));
  let editorRestored = false;
  function restoreEditor(): void {
    if (editorRestored) return;   // idempotent: close() and the record finally may both call
    editorRestored = true;
    stopPreviewTick();
    // put the shared camera back exactly where the editor had it before the modal
    scene.camera.position.copy(editorRestore.camPos);
    scene.camera.up.copy(editorRestore.camUp);
    scene.controls.target.copy(editorRestore.camTarget);
    scene.controls.update();
    if (bar) {
      bar.loop = editorRestore.loop;
      if (bar.select && editorRestore.value != null) bar.select.value = editorRestore.value;
      const orig = editorRestore.value != null ? clips.find((c) => String(c.i) === editorRestore.value) : null;
      if (orig && bar.loadClip) {
        // loadClip resets t and may auto-play (autoplay pref): force back to the
        // editor's exact prior playhead + play state.
        bar.loadClip(orig).then(() => {
          bar.t = editorRestore.t;
          bar.applyPose?.();
          if (editorRestore.playing) bar.play(); else bar.pause();
        }).catch(() => {});
      } else {
        bar.clearClip?.();   // editor had no clip (rest state): reset the rig
      }
    }
  }
  loadPreview(firstSelected());   // begin animating the moment the modal opens

  // ---- recording ------------------------------------------------------------
  const recBtn = el('button', { class: 'btn primary', text: '● Record & download' });
  const closeBtn = el('button', { class: 'btn', text: 'Close' });
  closeBtn.addEventListener('click', close);

  // every editable control is locked while recording (changing one mid-record
  // corrupts the output); Close stays live so a recording can be aborted.
  const formControls: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] =
    [fmtSel, gifFpsSel, clipSel, durIn, loopsIn, speedSel, holdIn, rotCb, rotModeSel, rotSpeed, secPerRotIn, numRotIn, resSel, wIn, hIn, capCb, capIn, gridCb, bgIn, bgDefBtn, transpCb, prevBtn, restartBtn];
  // remember each control's intrinsic disabled state (e.g. gridCb is disabled when
  // the scene has no grid) so re-enabling after a record doesn't clobber it.
  const formBaseline = new Map(formControls.map((c) => [c, c.disabled]));
  const setFormEnabled = (on: boolean) => {
    for (const c of formControls) c.disabled = on ? formBaseline.get(c)! : true;
    crop.lock(!on);   // freeze the crop guides while recording
  };

  recBtn.addEventListener('click', async () => {
    recBtn.disabled = true;
    setFormEnabled(false);
    let aborted = false;
    abortRec = () => { aborted = true; };
    const stopIf = () => aborted || closed;
    // abortable wait: resolves early when the recording is aborted / modal closed
    const waitRec = (ms: number) => new Promise<void>((res) => {
      const t = performance.now();
      const iv = setInterval(() => { if (stopIf() || performance.now() - t >= ms) { clearInterval(iv); res(); } }, 40);
    });
    const restore = {
      auto: scene.controls.autoRotate, speed: scene.controls.autoRotateSpeed,
      damping: scene.controls.enableDamping,
      pos: scene.camera.position.clone(), tgt: scene.controls.target.clone(),
    };
    let rec: MediaRecorder | null = null, timer: ReturnType<typeof setInterval> | 0 = 0;
    let stopSpin: (() => void) | null = null;   // online turntable tick (stopped in finally)
    try {
      const fmt = fmtSel.value;
      const queue = [...clipSel.selectedOptions].map((o) => clips.find((c) => c.i === +o.value)).filter(Boolean);
      // segments + their real-time lengths (see buildSegs: rotations mode fills
      // the turntable window; otherwise clip duration × loops ÷ speed).
      const segs = buildSegs();
      const holdMs = Math.max(0, Math.min(5000, (parseFloat(holdIn.value) || 0) * 1000));   // hold the final frame
      const totalMs = segs.reduce((a, s) => a + s.ms, 0);

      // Deterministic turntable: rotate a FIXED start offset about the world-up
      // axis by an ABSOLUTE angle each frame, so the model spins on the spot
      // (never drifts off-centre) and the spin lands on an exact whole number of
      // turns, independent of frame rate or rounding. Replaces OrbitControls
      // autoRotate (which assumed 60fps and, with the preview controls, dragged
      // the framing into a circle and stopped short of 360°).
      const spin = rotCb.checked;
      const turnAxis = scene.camera.up.clone().normalize();
      const turnTarget = scene.controls.target.clone();
      const turnBase = scene.camera.position.clone().sub(turnTarget);
      // total sweep: rotations mode → exactly numRot turns (°/s × duration works
      // out to 2π × numRot); speed mode → whatever the °/s covers over the take.
      const totalRotRad = spin ? degPerSec() * (totalMs / 1000) * (Math.PI / 180) : 0;
      const setTurntable = (angle: number) => {
        const off = turnBase.clone().applyAxisAngle(turnAxis, angle);
        scene.camera.position.copy(turnTarget).add(off);
        scene.camera.lookAt(turnTarget);
      };
      if (spin) {
        previewOrbit.setEnabled(false);      // stop the preview controls fighting the spin
        scene.controls.enableDamping = false;   // controls.update() must not smooth/lag the camera we set each frame
      }

      // GIF and the software-MP4 fallback are rendered OFFLINE: the animation
      // clock steps exactly 1/fps per frame and each frame is rendered to an
      // offscreen target and read back, however long that takes (the sync GPU
      // readback costs tens of ms at full res: recording runs slower than
      // real time, but EVERY frame is captured, so playback is always smooth
      // at exactly the chosen rate). Native webm/mp4 record the live composite
      // stream via MediaRecorder in real time, as before.
      const frameCapture = fmt === 'gif' || (fmt === 'mp4' && !nativeMp4);
      const capFps = fmt === 'gif' ? gifFps() : WASM_MP4_FPS;
      const capMaxW = fmt === 'gif' ? GIF_MAXW : 4096;
      const capFrames: Uint8ClampedArray[] = [];
      let capW = 0, capH = 0;
      let parts: Blob[] = [], stopped: Promise<unknown> | null = null;
      const cr = crop.rect();   // crop is fixed for the whole recording (guides are locked below)

      if (frameCapture) {
        capW = Math.min(capMaxW, cr.w) & ~1;
        capH = Math.round(capW * (comp.height / cr.w)) & ~1;
        // frames render the FULL scene, then the crop guides trim columns
        const scale = capW / cr.w;
        const fullW = Math.round(comp.width * scale) & ~1;
        const fx0 = Math.max(0, Math.min(fullW - capW, Math.round(cr.x * scale) & ~1));
        const capScratch = el('canvas'); capScratch.width = capW; capScratch.height = capH;
        const capCtx = capScratch.getContext('2d', { willReadFrequently: true })!;

        // the live preview tick must not fight the offline stepping
        previewPlaying = false;
        prevBtn.textContent = '▶';
        const transparent = transpCb.checked;
        const renderOne = () => {
          const f = renderCaptureFrame(scene, fullW, capH, { transparent });
          const cropped = cropRGBA(f.data, fullW, capH, fx0, capW);
          if (capCb.checked && capIn.value) {   // burn the caption onto the frame
            capCtx.putImageData(new ImageData(cropped, capW, capH), 0, 0);
            drawCaption(capCtx, capW, capH, { text: capIn.value, ...capStyle.style });
            capFrames.push(new Uint8ClampedArray(capCtx.getImageData(0, 0, capW, capH).data));
          } else {
            capFrames.push(cropped);
          }
        };

        // frames per segment cover [0, seg.ms) EXCLUSIVE, so the last frame of
        // a looping clip never wraps back to the start pose: a looping GIF
        // joins cleanly (frame after the last IS the first)
        const plans = segs.map((seg) => ({ seg, nF: Math.max(1, Math.floor((seg.ms * capFps) / 1000)) }));
        const totalF = plans.reduce((a, pl) => a + pl.nF, 0);
        // spread the full sweep over the ACTUAL frame count → frame 0 at 0°, the
        // frames cover [0, totalRotRad) so a whole-turn loop joins cleanly.
        const rotStep = spin && totalF > 0 ? totalRotRad / totalF : 0;
        let done = 0;
        let lastSampler: any = null;
        outer:
        for (const { seg, nF } of plans) {
          let sampler: any = null;
          if (seg.clip) {
            try { sampler = new ClipSampler(await app.store.payload(seg.clip.f)); }
            catch { /* unloadable clip: rest-pose frames */ }
          }
          lastSampler = sampler;
          for (let k = 0; k < nF; k++) {
            if (stopIf()) break outer;
            if (sampler) sampler.apply(rig, ((k / capFps) * 1000 * previewSpeed) % Math.max(1, sampler.duration));
            if (spin) setTurntable(done * rotStep);   // absolute angle for THIS frame (done = global frame index)
            renderOne();
            done++;
            if (done % 3 === 0 || done === totalF) {
              status.textContent = `Rendering… frame ${done} / ${totalF}`;
              await sleep(0);   // keep the UI (and the abort button) alive
            }
          }
        }
        // hold: one extra frame at the exact end pose; the GIF encoder holds it
        // via a longer last delay, software-MP4 by appending duplicates
        if (holdMs > 0 && !stopIf() && capFrames.length) {
          if (lastSampler) lastSampler.apply(rig, lastSampler.duration);
          renderOne();
          if (fmt === 'mp4') {
            const last = capFrames[capFrames.length - 1];
            for (let i = 1, n = Math.round((holdMs / 1000) * capFps); i < n; i++) capFrames.push(last);
          }
        }
      } else {
        const mime = (fmt === 'mp4' ? nativeMp4 : mimes.find(([label]) => label === fmt)![1])!;
        rec = new MediaRecorder(cropCanvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: VIDEO_BPS });
        parts = [];
        rec.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };
        stopped = new Promise((res) => { rec!.onstop = res; });
        rec.start(200);

        const t0 = performance.now();
        // wall-clock turntable: set the absolute angle from elapsed/total each
        // frame, so it lands on exactly totalRotRad regardless of the real fps.
        if (spin) stopSpin = scene.addTick(() => {
          setTurntable(Math.min(1, (performance.now() - t0) / Math.max(1, totalMs)) * totalRotRad);
        });
        timer = setInterval(() => {
          status.textContent = `Recording… ${((performance.now() - t0) / 1000).toFixed(1)}s / ${(totalMs / 1000).toFixed(1)}s`;
        }, 200);

        for (const seg of segs) {
          if (stopIf()) break;
          if (seg.clip) await loadPreview(seg.clip);   // drives the preview sampler
          else { previewSampler = null; previewPlaying = false; }
          await waitRec(seg.ms);
        }
        // hold the final frame in real time (the recorder keeps rolling)
        if (holdMs > 0 && !stopIf()) {
          if (previewSampler) { previewT = previewSampler.duration; previewSampler.apply(rig, previewT); }
          previewPlaying = false;
          await waitRec(holdMs);
        }
        clearInterval(timer); timer = 0;
      }

      if (stopIf()) {   // aborted / modal closed → stop cleanly, no download
        if (rec && rec.state !== 'inactive') { rec.stop(); await stopped; }
        status.textContent = 'Recording cancelled.';
        return;
      }

      let blob: Blob, ext: string;
      if (fmt === 'gif') {
        status.textContent = `Encoding GIF (${capFrames.length} frames)…`;
        await sleep(30);   // let the status paint before the synchronous encode
        const bytes = encodeGif(capFrames, capW, capH, { delayMs: 1000 / gifFps(), transparent: transpCb.checked, holdMs });
        blob = new Blob([bytes], { type: 'image/gif' });
        ext = 'gif';
      } else if (frameCapture) {   // software H.264 (e.g. Firefox, which has no MP4 recorder)
        status.textContent = 'Loading MP4 encoder…';
        const { default: HME } = await import('../../vendor/h264-mp4-encoder.module.js');
        const enc = await HME.createH264MP4Encoder();
        enc.width = capW; enc.height = capH; enc.frameRate = capFps;
        enc.kbps = Math.round(WASM_MP4_BPS / 1000);
        enc.initialize();
        // frames are RGBA + top-down straight from a 2D canvas: no Y-flip. Yield
        // periodically so the status paints and the synchronous encoder doesn't
        // hard-freeze the tab.
        for (let i = 0; i < capFrames.length; i++) {
          enc.addFrameRgba(capFrames[i]);
          if (i % 12 === 11) { status.textContent = `Encoding MP4… ${i + 1}/${capFrames.length}`; await sleep(0); }
        }
        enc.finalize();
        const mp4 = enc.FS.readFile(enc.outputFilename);
        try { enc.FS.unlink(enc.outputFilename); } catch { /* fine */ }
        enc.delete();
        blob = new Blob([mp4], { type: 'video/mp4' });
        ext = 'mp4';
      } else {
        rec!.stop();
        await stopped;
        blob = new Blob(parts, { type: rec!.mimeType.split(';')[0] });
        ext = fmt;
      }

      // re-check after the encode/flush await: the modal may have been closed
      // (or the recording aborted) while we waited. Don't download in that case.
      if (stopIf()) { status.textContent = 'Recording cancelled.'; return; }

      const name = `rig_${entry.i}${queue.length ? `_clip${queue.map((c) => c.i).join('-')}` : ''}.${ext}`;
      const a = el('a', { href: URL.createObjectURL(blob), download: name });
      a.click();
      URL.revokeObjectURL(a.href);
      status.textContent = `Done: downloaded ${name} (${(blob.size / 1e6).toFixed(1)} MB).`;
      app.banner(`recorded ${name}`, 'b-info');
    } catch (err) {
      status.textContent = `Recording failed: ${err.message}`;
    } finally {
      if (timer) clearInterval(timer);
      stopSpin?.();                       // stop the turntable tick BEFORE restoring the camera
      previewOrbit.setEnabled(true);      // hand framing back to the preview controls
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* already stopping */ } }
      abortRec = null;
      // always restore the shared scene (whether or not the modal is still open)
      scene.controls.autoRotate = restore.auto;
      scene.controls.autoRotateSpeed = restore.speed;
      scene.controls.enableDamping = restore.damping;
      if (!closed) {   // if the modal has closed, restoreEditor() already put the camera back to its pre-modal framing
        scene.camera.position.copy(restore.pos);
        scene.controls.target.copy(restore.tgt);
        scene.camera.lookAt(restore.tgt);
      }
      recBtn.disabled = false;
      setFormEnabled(true);
    }
  });

  // Duration (no clips) / Loops-each (clips) are toggled by syncRotUI (in
  // rotations mode the turntable owns the recording length), so build them as
  // named elements rather than inline.
  durLabel = hasClips ? null : el('label', {}, el('span', { text: 'Duration' }), durIn, el('span', { class: 'dim small', text: 'seconds' }));
  loopsWrap = hasClips ? el('span', {}, el('span', { text: 'Loops each' }), loopsIn, el('span', { class: 'sep-mini' })) : null;
  const clipParamsLabel = hasClips
    ? el('label', {}, loopsWrap, el('span', { text: 'Speed' }), speedSel,
      el('span', { class: 'sep-mini' }), el('span', { text: 'Hold end' }), holdIn, el('span', { class: 'dim small', text: 's' }))
    : null;
  const rotRow = el('label', {}, rotCb, el('span', { text: 'Turntable' }), rotModeSel, rotSpeedWrap, rotCountWrap);

  overlay.appendChild(el('div', { class: 'modal card video-modal' },
    el('h2', { text: 'Record a video' }),
    // scrollable body: on short screens the form + preview scroll here so the
    // header above and the action buttons below stay pinned and reachable.
    el('div', { class: 'modal-body video-body' },
      el('div', { class: 'video-form' },
        el('label', {}, el('span', { text: 'Format' }), fmtSel, gifFpsWrap, fmtHint),
        el('label', {}, el('span', { text: 'Resolution' }), resSel, customWrap, el('span', { class: 'sep-mini' }), el('span', { class: 'dim small', text: '→' }), dimsLbl, el('span', { class: 'sep-mini' }), sizeLbl),
        hasClips
          ? el('label', { class: 'video-clips-row' }, el('span', { text: 'Animations' }), clipSel)
          : durLabel,
        clipParamsLabel,
        rotRow,
        el('label', {}, capCb, el('span', { text: 'Caption' }), capIn),
        capStyle.row,
        el('label', {}, gridCb, el('span', { text: ov.hasGrid ? 'Grid lines' : 'Grid lines (none in scene)' }),
          el('span', { class: 'sep-mini' }), el('span', { text: 'Background' }), bgIn, bgDefBtn,
          el('span', { class: 'sep-mini' }), transpCb, el('span', { text: 'Transparent' }))),
      cropWrap,
      el('div', { class: 'video-preview-ctrls' }, prevBtn, restartBtn),
      status),
    el('div', { class: 'modal-actions' }, recBtn, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
  syncRotUI();   // initial turntable-control visibility (speed vs rotations)
}
