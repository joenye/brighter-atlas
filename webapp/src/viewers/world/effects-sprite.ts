// The particle sprite program and sprite metrics, shared by both effect
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

/** Shared particle depth and blend equations for every viewing surface.
 * The shader supplies straight RGB, so the source RGB factor applies alpha.
 * Alpha itself always accumulates as source-over, including additive RGB. */
export function spriteMaterialState(blend: 'add' | 'mix'): THREE.ShaderMaterialParameters {
  return {
    transparent: true, depthWrite: false, depthTest: true, depthFunc: THREE.LessDepth,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor,
    blendDst: blend === 'add' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  };
}

/** Sprite filtering is independent of the scene's mesh texture settings. */
export function configureSpriteSampling(texture: THREE.Texture): void {
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 1;
}

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

type EmitterSprite = { material: number; images: number[]; draw?: SpriteDraw | null };
/** The sprite outcomes an emitter draws: its single sprite (choice -1), or
 *  each outcome of a uniform per-particle selection. A computed selection is
 *  drawn only once its spawn shape is bound as well; otherwise its origin
 *  and motion would still be structural guesses. */
export function emitterSpriteDraws(emitter: { sprite?: EmitterSprite | null;
  sprite_choices?: { sprites: EmitterSprite[] } | null; shape?: number | null },
configs: Record<string, { origin?: 'bound' }>): { sprite: EmitterSprite; choice: number }[] {
  const choices = emitter.sprite_choices?.sprites;
  if (!emitter.sprite && choices?.length && configs[String(emitter.shape)]?.origin === 'bound') {
    return choices.flatMap((sprite, choice) => (sprite?.images?.length ? [{ sprite, choice }] : []));
  }
  return emitter.sprite?.images?.length ? [{ sprite: emitter.sprite, choice: -1 }] : [];
}

// The quad is built in view space, after the model-view transform and before
// projection, except a fixed plane (aFacingMode 0 with an axis), which is
// built in model space. uSpriteSize carries the sprite's native dimensions
// and aPosSize.w the per-particle scale (already converted to the surface's
// own units), and the corner is scaled by both BEFORE the roll rotation so a
// non-square sprite rotates as the rectangle it is.
export const BILLBOARD_VERTEX = `
attribute vec4 aPosSize;
attribute vec4 aColor;
attribute float aRot;
attribute vec3 aFacing;
attribute float aFacingMode;
uniform vec2 uSpriteSize;
uniform float uFacingSizeScale;
varying vec2 vUv;
varying vec4 vColor;
#include <common>
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4( aPosSize.xyz, 1.0 );
  vec2 e = position.xy * uSpriteSize * aPosSize.w;
  float c = cos( aRot );
  float s = sin( aRot );
  // Positive roll turns the upper edge toward screen right.
  vec2 rolled = vec2( e.x * c + e.y * s, -e.x * s + e.y * c );
  float facingLength = length( aFacing );
  if ( aFacingMode > 3.5 && ((aFacingMode > 4.5 && facingLength > 0.0) || (aFacingMode < 4.5 && facingLength * facingLength >= 0.000001)) ) {
    vec3 direction = mat3( modelViewMatrix ) * ( aFacing / facingLength );
    float directionLength = length( direction );
    vec2 projected = ( direction.xy - mvPosition.xy * ( direction.z / mvPosition.z ) ) / directionLength;
    float projectedLength = length( projected );
    vec2 along = projectedLength < 0.001 ? vec2( 0.0, 1.0 ) : projected / projectedLength;
    float aspect = uSpriteSize.x / uSpriteSize.y;
    if ( aFacingMode > 4.5 ) aspect = max( 0.02, aspect );
    float height = max( aspect, projectedLength ) * e.y;
    mvPosition.xy += ( vec2( -along.y, along.x ) * e.x - along * height ) * directionLength * uFacingSizeScale;
  } else if ( aFacingMode > 0.5 && aFacingMode < 1.5 && facingLength * facingLength >= 0.000001 ) {
    vec3 direction = mat3( modelViewMatrix ) * ( aFacing / facingLength );
    float directionLength = length( direction );
    direction /= directionLength;
    vec3 side = cross( direction, mvPosition.xyz );
    if ( dot( side, side ) < 0.000001 ) side = cross( direction, vec3( 0.0, 1.0, 0.0 ) );
    side = normalize( side );
    // Velocity planes use unrolled corners; their height follows motion.
    mvPosition.xyz += ( side * e.x - direction * e.y ) * directionLength * uFacingSizeScale;
  } else if ( aFacingMode < 0.5 && facingLength > 0.0 ) {
    // Source axes are normalized after the independent birth and owner frames.
    vec3 n = aFacing / facingLength;
    vec3 auxiliary = abs( n.z ) > 0.999 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 0.0, 0.0, 1.0 );
    vec3 u = normalize( cross( auxiliary, n ) );
    vec3 v = cross( n, u );
    mvPosition = modelViewMatrix * vec4( aPosSize.xyz + ( u * rolled.x + v * rolled.y ) * uFacingSizeScale, 1.0 );
  } else {
    float viewScale = length( vec3( modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0] ) );
    mvPosition.xy += rolled * viewScale * uFacingSizeScale;
  }
  gl_Position = projectionMatrix * mvPosition;
}`;

// uMask selects the channel layout (1.0 = single-channel coverage mask). Both
// branches produce the same shape: tint in rgb, coverage in alpha.
// Particle colours are already in the drawing colour space. Applying the
// mesh output transfer here brightens them before blending and washes out
// overlapping coloured particles. Capture targets use the same drawing space.
export const BILLBOARD_FRAGMENT = `
uniform sampler2D map;
uniform float uMask;
varying vec2 vUv;
varying vec4 vColor;
#include <common>
void main() {
  vec4 texel = texture2D( map, vUv );
  float coverage = mix( texel.a, texel.r, uMask );
  vec3 tint = mix( texel.rgb, vec3( 1.0 ), uMask );
  gl_FragColor = vec4( tint * vColor.rgb, coverage * vColor.a );
}`;

/** The program's own uniforms for a batch drawing `draw`. World batches
 * convert stored sizes to display units before upload; oriented offsets need
 * that conversion reversed before their model-view transform. */
export function spriteUniforms(draw: SpriteDraw, facingSizeScale = 1): Record<string, { value: any }> {
  return {
    uFacingSizeScale: { value: facingSizeScale },
    uSpriteSize: { value: new THREE.Vector2(draw.w, draw.h) },
    uMask: { value: draw.mask ? 1 : 0 },
  };
}

/** A coverage mask is linear data, not colour: decoding it through the sRGB
 *  transfer function would bend the particle's falloff. */
export function spriteColorSpace(draw: SpriteDraw): any {
  return draw.mask ? THREE.NoColorSpace : THREE.SRGBColorSpace;
}
