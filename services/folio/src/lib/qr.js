const QRCode = require('qrcode');

// QR rendering, in the two shapes this system needs: a PNG buffer for embedding in
// a PDF with doc.image(), and a data URI for showing in the browser.
//
// Rendered locally with no network call, which is what keeps printed documents and
// the payment screen working with the wifi off. A data URI also needs no extra
// content-security grant — the gateway already allows `img-src 'self' data:`.
//
// Error-correction level M (~15%) rather than the L default: these codes get
// printed, photocopied, folded into a guest's wallet and photographed at an angle.
// L is for pristine screens.
const OPTIONS = { errorCorrectionLevel: 'M', margin: 1, width: 220 };

function requirePayload(text) {
  // An empty payload renders as a valid but meaningless QR code — a square that
  // scans to "". Failing loudly beats printing that on a guest's receipt.
  if (!text) throw new Error('Refusing to render an empty QR code.');
  return String(text);
}

async function qrPngBuffer(text) {
  return QRCode.toBuffer(requirePayload(text), { type: 'png', ...OPTIONS });
}

async function qrDataUrl(text) {
  return QRCode.toDataURL(requirePayload(text), { type: 'image/png', ...OPTIONS });
}

module.exports = { qrPngBuffer, qrDataUrl };
