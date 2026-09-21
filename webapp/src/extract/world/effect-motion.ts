export interface EffectMotionAxis {
  amplitude: number;
  spatialFrequency: number;
  temporalFrequency: number;
}

export interface EffectMotion {
  x: EffectMotionAxis;
  y: EffectMotionAxis;
}

export interface EffectAttachmentMotion extends EffectMotion {
  // Rotated owner dimensions in tiles and the stored room origin in tiles.
  footprint: [number, number];
  origin: [number, number];
}
