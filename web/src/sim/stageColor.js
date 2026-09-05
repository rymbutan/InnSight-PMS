// The backdrop colour behind every 3D canvas, read from the theme.
//
// WebGL cannot read a CSS custom property: `gl.setClearColor` takes a literal,
// copied into the renderer at creation. So each canvas resolved its own — and
// each one hardcoded the same khaki, which is why changing the backdrop meant
// finding four unrelated files.
//
// Resolved at CALL time, never captured at module load: the value changes under
// the same DOM when the theme toggles or an admin edits the palette in
// Settings, and a value read once at import would be the colour that happened
// to be live when the chunk loaded.
export function stageColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim();
  // Matches the light-theme token. Only reachable before the stylesheet has
  // applied, which is a frame at most, but a canvas with no clear colour is
  // black — a much worse failure than one frame of the wrong grey.
  return v || '#ced3da';
}
