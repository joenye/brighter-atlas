import { Rig, ClipSampler, clipPhase } from '../rig.js';

/** A private sampling rig keeps historical particle births independent of
 *  the skeleton currently displayed by an animated mesh. All matrices are
 *  owner-local; the effect layer supplies placement and stitched offsets. */
export class EffectBoneAnimation {
  readonly rig: number;
  readonly inverseBinds: readonly (readonly number[])[];
  private skeleton: Rig;
  private clip: ClipSampler;
  private lastTick = NaN;
  private pose: number[][] = [];

  /** `heldTick`: the pose stays at that tick of the clip whatever the effects' clock (an actor standing posed in
   *  its resting clip's first frame). */
  constructor(skeletonJson: any, clipJson: any, private loop: boolean,
    private tickRate: number, private elapsedMs: () => number, private heldTick: number | null = null) {
    this.skeleton = new Rig(skeletonJson);
    this.rig = this.skeleton.skelIndex;
    this.inverseBinds = this.skeleton.boneInverses.map(m => m.elements.slice());
    this.clip = new ClipSampler(clipJson);
  }

  /** The clip's clock in effect ticks; null for a held pose, whose effect keeps the view's own clock. */
  time(): number | null { return this.heldTick !== null ? null : this.elapsedMs() * this.tickRate / 1000; }

  dispose(): void { this.skeleton.skeleton.dispose(); }

  sample(tick: number): readonly (readonly number[])[] {
    if (this.heldTick !== null) tick = this.heldTick;
    if (tick !== this.lastTick) {
      // (the effects' tick to the clip's time: both the game's ticks, 600 a second, at the effects' own rate)
      this.clip.apply(this.skeleton, clipPhase(tick * 600 / this.tickRate, this.clip.duration, this.loop));
      for (const root of this.skeleton.roots) root.updateMatrixWorld(true);
      this.pose = this.skeleton.bones.map(b => b.matrixWorld.elements.slice());
      this.lastTick = tick;
    }
    return this.pose;
  }
}
