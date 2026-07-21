// Ambient types for the vendored runtime modules (webapp/vendor/*).
// The npm packages listed in devDependencies exist ONLY to supply these
// types; the runtime always loads the vendored files.

declare module '*/vendor/three.module.js' {
  export * from 'three';
}

declare module '*/vendor/OrbitControls.js' {
  export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
}

declare module '*/vendor/GLTFExporter.js' {
  export { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
}

declare module '*/vendor/fflate.module.js' {
  export * from 'fflate';
}

declare module '*/vendor/fzstd.module.js' {
  export * from 'fzstd';
}

declare module '*/vendor/zstd-wasm.module.js' {
  export function init(): Promise<void>;
  export function decompress(u8: Uint8Array, dstCapacity: number): Uint8Array;
}

declare module '*/vendor/opus-decoder.module.js' {
  export const OpusDecoder: any;
  export const OpusDecoderWebWorker: any;
}

declare module '*/vendor/h264-mp4-encoder.module.js' {
  const HME: any;
  export default HME;
}
