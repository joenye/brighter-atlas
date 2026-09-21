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

  constructor(skeletonJson: any, clipJson: any, private loop: boolean,
    private tickRate: number, private elapsedMs: () => number) {
    this.skeleton = new Rig(skeletonJson);
    this.rig = this.skeleton.skelIndex;
    this.inverseBinds = this.skeleton.boneInverses.map(m => m.elements.slice());
    this.clip = new ClipSampler(clipJson);
  }

  time(): number { return this.elapsedMs() * this.tickRate / 1000; }

  dispose(): void { this.skeleton.skeleton.dispose(); }

  sample(tick: number): readonly (readonly number[])[] {
    if (tick !== this.lastTick) {
      this.clip.apply(this.skeleton, clipPhase(tick * 1000 / this.tickRate, this.clip.duration, this.loop));
      for (const root of this.skeleton.roots) root.updateMatrixWorld(true);
      this.pose = this.skeleton.bones.map(b => b.matrixWorld.elements.slice());
      this.lastTick = tick;
    }
    return this.pose;
  }
}
