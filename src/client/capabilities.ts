/** Feature checks for everything the game needs; returns a human-readable reason when unsupported. */
export function unsupportedReason(): string | null {
  if (typeof indexedDB === 'undefined') return 'IndexedDB is unavailable (is this a restricted/private window with storage disabled?).';
  if (typeof Worker === 'undefined') return 'Web Workers are unavailable.';
  if (typeof DecompressionStream === 'undefined') return 'DecompressionStream is unavailable (Chrome 80+ / Firefox 113+ needed).';
  try {
    new DecompressionStream('deflate-raw');
  } catch {
    return 'DecompressionStream("deflate-raw") is unsupported (Chrome 103+ / Firefox 113+ needed).';
  }
  if (typeof createImageBitmap === 'undefined') return 'createImageBitmap is unavailable.';
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) {
    return (
      'WebGL 2 is unavailable. In Chrome/Edge enable "Use graphics acceleration when available"; ' +
      'in Firefox check that hardware acceleration is on and webgl.disabled is false (about:config). ' +
      'On Linux, Firefox blocks WebGL on some GPU drivers: setting webgl.force-enabled to true in about:config ' +
      'turns it back on (software rendering if needed).'
    );
  }
  return null;
}

/** Normalises wheel deltas across browsers/OSes (Firefox often reports lines, Chrome pixels). */
export function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16; // DOM_DELTA_LINE
  if (e.deltaMode === 2) return e.deltaY * 400; // DOM_DELTA_PAGE
  return e.deltaY;
}
