import * as THREE from '../../vendor/three.module.js';

/** Skin in the shared rig frame, then apply this part's own affine matrix.
 * AttachedBindMode normally cancels the entire mesh world matrix, which also
 * cancels an authored part offset when the bones have a different parent.
 */
export class PartSkinnedMesh extends THREE.SkinnedMesh {
  rigFrame: THREE.Object3D;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, rigFrame: THREE.Object3D) {
    super(geometry, material);
    this.rigFrame = rigFrame;
  }

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    this.rigFrame.updateWorldMatrix(true, false);
    this.bindMatrixInverse.copy(this.rigFrame.matrixWorld).invert();
  }
}
