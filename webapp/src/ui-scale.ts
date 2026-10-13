// The interface's size. The stylesheets are written in rem against a 16px root (css/app.css, `html`): the root
// is the browser's own text size on phones, tablets and laptops, and grows on wide desktop screens. A length
// the code sets itself is written at the base size, then multiplied by uiScale() (or set in rem).

let cached = 0;

/** The root font size over 16px: 1 at the base size, 1.2 on a 2560-wide desktop window. */
export function uiScale(): number {
  if (!cached) cached = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
  return cached;
}

/** A base-size length in px as rem, for an inline style. */
export const rem = (px: number): string => `${px / 16}rem`;

// (the root size follows the window's width; no window where tools load this module under Node)
if (typeof window !== 'undefined') addEventListener('resize', () => { cached = 0; });
