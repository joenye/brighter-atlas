// The model's card picture, full size: the picture the game shows on the
// model's information card (model-cards.ts), with a download at a chosen
// resolution, on the card's own backdrop or transparent.

import { el } from '../ui.js';
import { download } from '../asset-export.js';
import { modelCards, type CardBackdrop } from './model-cards.js';

const SCALES: [number, string][] = [[1, '1x'], [2, '2x'], [3, '3x'], [4, '4x'], [6, '6x'], [8, '8x']];

const fileName = (name: string, icon: boolean, scale: number) =>
  `brighter-atlas-card-${(name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}${icon ? '-icon' : ''}-${scale}x.png`;

export async function openCardModal(app: any, model: { id: string; name?: string }): Promise<void> {
  const cards = modelCards(app.store);
  if (!(await cards.card(model.id))) { app.banner('this model has no card picture (extract the World category, or the model is not shown on a card)'); return; }
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  const viewSel = el('select', { class: 'btn' },
    el('option', { value: 'card', text: 'Card view' }),
    el('option', { value: 'icon', text: 'Square view' }));
  const bgSel = el('select', { class: 'btn' },
    el('option', { value: 'card', text: 'Card background' }),
    el('option', { value: 'none', text: 'Transparent' }));
  const scaleSel = el('select', { class: 'btn' });
  for (const [s, label] of SCALES) scaleSel.appendChild(el('option', { value: String(s), text: label }));
  scaleSel.value = '4';
  const dims = el('span', { class: 'dim small' });
  const status = el('div', { class: 'dim small' });
  const preview = el('div', { class: 'card-preview' });
  const dlBtn = el('button', { class: 'btn primary', text: 'Download PNG' });
  const closeBtn = el('button', { class: 'btn', text: 'Close' });
  closeBtn.addEventListener('click', close);

  const options = () => ({ icon: viewSel.value === 'icon', backdrop: bgSel.value as CardBackdrop, scale: Number(scaleSel.value) });
  const updateDims = () => {
    const { icon, scale } = options();
    dims.textContent = icon ? `${320 * scale}×${320 * scale}` : `${372 * scale}×${255 * scale}`;
  };
  let generation = 0;
  const refresh = async () => {
    updateDims();
    const g = ++generation;
    const { icon, backdrop } = options();
    status.textContent = 'Drawing…';
    const canvas = await cards.render(model.id, 2, backdrop, icon).catch(() => null);
    if (g !== generation) return;
    if (!canvas) { status.textContent = 'This card could not be drawn.'; return; }
    canvas.className = backdrop === 'none' ? 'checker' : '';
    preview.replaceChildren(canvas);
    status.textContent = '';
  };
  for (const s of [viewSel, bgSel]) s.addEventListener('change', refresh);
  scaleSel.addEventListener('change', updateDims);
  dlBtn.addEventListener('click', async () => {
    const { icon, backdrop, scale } = options();
    dlBtn.disabled = true; status.textContent = `Drawing at ${scale}x…`;
    try {
      const canvas = await cards.render(model.id, scale, backdrop, icon);
      if (!canvas) throw new Error('no card');
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('encode failed');
      download(blob, fileName(model.name ?? '', icon, scale));
      status.textContent = '';
    } catch {
      status.textContent = 'This size could not be drawn (try a smaller one).';
    } finally { dlBtn.disabled = false; }
  });

  overlay.appendChild(el('div', { class: 'modal card video-modal' },
    el('h2', { text: `Card picture: ${model.name || 'model'}` }),
    el('div', { class: 'video-form' },
      el('label', {}, el('span', { text: 'View' }), viewSel, el('span', { class: 'sep-mini' }),
        el('span', { text: 'Background' }), bgSel),
      el('label', {}, el('span', { text: 'Size' }), scaleSel, dims)),
    preview,
    status,
    el('div', { class: 'modal-actions' }, dlBtn, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
  refresh();
}
