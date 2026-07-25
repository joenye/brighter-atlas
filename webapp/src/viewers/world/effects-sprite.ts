// The particle billboard program and sprite metrics, shared by both effect
// renderers (the room layer and the model-page player). Those two files keep
// their own batch internals and lifecycles deliberately separate, but the
// drawing math below is the game's own and must exist in exactly ONE place:
// a divergence between the two surfaces would show up as an accuracy
// regression on one of them rather than as an obvious bug.
//
// Quad size. A particle quad is sized from the sprite's own stored
// dimensions, not from a tuned constant: one stored texel is one native unit,
// so the quad is `scale x (w, h)` and the whole image (transparent gutter
// included) maps onto it. Non-square sprites therefore keep their aspect,
// which matters: most emitters use one, and forcing them square turns
// streaks and icons into round blobs.
//
// Sprite channels. A decoded sprite carries one of two layouts. Most are a
// single-channel intensity MASK: the source format has no alpha at all, so
// the decoder replicates the mask across RGB and leaves alpha fully opaque.
// That mask is COVERAGE, and reading it as colour paints an opaque grey
// rectangle wherever the effect blends normally. The rest are straight RGBA
// (colour, or luminance plus a real alpha) and read as-is.
//
// Alpha convention. Instance colours arrive STRAIGHT (not premultiplied), so
// the standard additive and normal blend factors apply unchanged: the
// fragment's rgb is the tint and its alpha is the coverage, and the blender
// forms `rgb * a` either way. The three-phase colour envelope is composed in
// premultiplied space on the CPU (effects-sim.ts) and converted back before
// it reaches this attribute, because only the composition needs it.

import * as THREE from '../../../vendor/three.module.js';

/** How to draw one sprite container: which sub-image, its dimensions in
 *  native units, and whether its single channel is coverage. */
export interface SpriteDraw { sub: number; w: number; h: number; mask: boolean }

/** Used when a container carries no readable image metadata, and for the
 *  built-in fallback dot. Square, straight-alpha, first sub-image. */
export const DEFAULT_SPRITE_DRAW: SpriteDraw = { sub: 0, w: 64, h: 64, mask: false };

/** The doc's per-emitter sprite record -> draw metrics, defaulted. Docs
 *  written before sprites carried metrics have no `draw` at all. */
export function spriteDrawOf(sprite: { draw?: SpriteDraw | null } | null | undefined): SpriteDraw {
  const draw = sprite?.draw;
  if (!draw || !(Number(draw.w) > 0) || !(Number(draw.h) > 0)) return DEFAULT_SPRITE_DRAW;
  return {
    sub: Number(draw.sub) || 0,
    w: Number(draw.w), h: Number(draw.h),
    mask: !!draw.mask,
  };
}

// View-space billboard: the quad is built after the model-view transform and
// before projection, so it always faces the camera. uSpriteSize carries the
// sprite's native dimensions and aPosSize.w the per-particle scale (already
// converted to the surface's own units), and the corner is scaled by both
// BEFORE the roll rotation so a non-square sprite rotates as the rectangle it
// is.
export const BILLBOARD_VERTEX = `
attribute vec4 aPosSize;
attribute vec4 aColor;
attribute float aRot;
uniform vec2 uSpriteSize;
varying vec2 vUv;
varying vec4 vColor;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4( aPosSize.xyz, 1.0 );
  vec2 e = position.xy * uSpriteSize * aPosSize.w;
  float c = cos( aRot );
  float s = sin( aRot );
  mvPosition.xy += vec2( e.x * c - e.y * s, e.x * s + e.y * c );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

// uMask selects the channel layout (1.0 = single-channel coverage mask). Both
// branches produce the same shape: tint in rgb, coverage in alpha.
export const BILLBOARD_FRAGMENT = `
uniform sampler2D map;
uniform float uMask;
varying vec2 vUv;
varying vec4 vColor;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 texel = texture2D( map, vUv );
  float coverage = mix( texel.a, texel.r, uMask );
  vec3 tint = mix( texel.rgb, vec3( 1.0 ), uMask );
  gl_FragColor = vec4( tint * vColor.rgb, coverage * vColor.a );
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** The program's own uniforms for a batch drawing `draw`. */
export function spriteUniforms(draw: SpriteDraw): Record<string, { value: any }> {
  return {
    uSpriteSize: { value: new THREE.Vector2(draw.w, draw.h) },
    uMask: { value: draw.mask ? 1 : 0 },
  };
}

/** A coverage mask is linear data, not colour: decoding it through the sRGB
 *  transfer function would bend the particle's falloff. */
export function spriteColorSpace(draw: SpriteDraw): any {
  return draw.mask ? THREE.NoColorSpace : THREE.SRGBColorSpace;
}
