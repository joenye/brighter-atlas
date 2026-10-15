// Textures from the app's own PNGs, decoded off the page's thread. An image element is decoded on it, when it is
// first drawn (the all-rooms view spent seconds there); a bitmap is decoded beforehand, elsewhere, and given to the
// texture as the image element's would be: rows from the bottom up and colours not premultiplied. The PNGs carry
// no colour profile, so converting colours or not gives the same bytes (checked texel for texel); a colour picture
// is converted as the browser would, data is left as it is.
import * as THREE from '../../vendor/three.module.js';

export async function loadBitmapTexture(url: string, colorSpace: THREE.ColorSpace = THREE.NoColorSpace): Promise<THREE.Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    imageOrientation: 'flipY', premultiplyAlpha: 'none',
    colorSpaceConversion: colorSpace === THREE.NoColorSpace ? 'none' : 'default',
  });
  const texture = new THREE.Texture(bitmap as any);
  texture.flipY = false;   // (flipped as it was decoded: the upload's own flip does not apply to a bitmap)
  texture.needsUpdate = true;
  return texture;
}

/** THREE.TextureLoader's loadAsync, decoding off the page's thread where the browser can (else its own loader). */
export class BitmapTextureLoader {
  private fallback: THREE.TextureLoader | null = null;
  loadAsync(url: string): Promise<THREE.Texture> {
    if (typeof createImageBitmap === 'function') return loadBitmapTexture(url);
    return (this.fallback ??= new THREE.TextureLoader()).loadAsync(url);
  }
}
