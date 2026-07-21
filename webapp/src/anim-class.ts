// Structurally-CERTAIN behaviour classification for animation clips, derived
// from anim_dir facts (duration + skeleton). These are NOT names — the real
// name→clip join is behind an unbroken 63-bit name-hash, so only the honest,
// verifiable partial is claimed: a ≤1-frame clip genuinely has no keyframes;
// an 18s clip is genuinely a long loop. Interpretation ("idle") stays a hint,
// not a claim.

export interface AnimClassBadge { tag: string; cls: string; title: string }

// -> { tag, cls, title } | null
export function animClass(entry: { dur?: number; frames?: number } | null | undefined): AnimClassBadge | null {
  if (!entry) return null;
  const dur = entry.dur ?? 0;
  const frames = entry.frames ?? Math.ceil(dur / 20) + 1;
  if (frames <= 1 || dur <= 20) {
    return { tag: 'no motion', cls: 'b-ghost', title: 'Duration ≤ 1 frame — no rig keyframes. Almost certainly an sfx/particle event or a static pose, not a character animation (structural fact from the clip duration).' };
  }
  if (dur >= 18000) {
    return { tag: 'long loop', cls: 'b-accent b-ghost', title: `${(dur / 1000).toFixed(0)}s clip — a long ambient/idle loop (structural fact; the "idle" reading is a hint, not a confirmed name).` };
  }
  return null;
}
