// The one place that decides what a guest-facing link says.
//
// This system has to keep working in two modes, and the client needs both in the
// same month: on a laptop with the wifi off, where the only reachable address is
// localhost, and on a public host, where a phone can open a link and scan a code.
// One environment variable separates them — no build-time branching, no second
// image, no rebuild to switch. PUBLIC_BASE_URL is read once at require time.
//
// `isScannableByPhone` exists because a QR code encoding http://localhost:8080 is
// dead on arrival: a phone resolving "localhost" reaches itself. Callers use the
// flag to choose between telling the user to scan and offering an on-screen
// confirmation, so an offline demo degrades honestly rather than printing a code
// nobody can use.
function makePublicUrl(base) {
  const root = String(base || 'http://localhost:8080').replace(/\/+$/, '');

  const fn = (path) => `${root}/${String(path).replace(/^\/+/, '')}`;
  fn.base = root;
  // Anchored to the authority component, not a substring match: a real host called
  // localhost-demo.example.com is perfectly scannable.
  fn.isScannableByPhone = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(root);

  return fn;
}

// PORTAL_URL is honoured as a fallback so an existing deployment that only sets
// that keeps working; new configuration should use PUBLIC_BASE_URL.
const publicUrl = makePublicUrl(process.env.PUBLIC_BASE_URL || process.env.PORTAL_URL);

module.exports = { makePublicUrl, publicUrl };
