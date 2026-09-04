const test = require('node:test');
const assert = require('node:assert');
const { qrPngBuffer, qrDataUrl } = require('./qr');

test('produces a real PNG buffer', async () => {
  const buf = await qrPngBuffer('https://innsight.example/portal/R-1');
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic bytes');
  assert.ok(buf.length > 200, 'a plausible image, not an empty stub');
});

test('produces a data URI the browser can render', async () => {
  const uri = await qrDataUrl('https://innsight.example/pay/abc');
  // The gateway CSP allows img-src 'self' data: — a data URI needs no network and
  // no additional grant, which is what keeps this working offline.
  assert.match(uri, /^data:image\/png;base64,/);
});

test('refuses an empty payload rather than printing an unreadable square', async () => {
  await assert.rejects(() => qrPngBuffer(''), /empty/i);
  await assert.rejects(() => qrPngBuffer(null), /empty/i);
  await assert.rejects(() => qrDataUrl(undefined), /empty/i);
});

test('encodes a long URL without throwing', async () => {
  // Folio numbers here are timestamp-based and receipt numbers concatenate them,
  // so guest-facing URLs get long. QR capacity is finite; this is the realistic
  // upper bound and it must fit.
  const long = `https://innsight.example/portal/OR-F-1788530276395-673-9311ea35d665?src=receipt`;
  const buf = await qrPngBuffer(long);
  assert.ok(Buffer.isBuffer(buf));
});

test('the same payload renders identically', async () => {
  // Reprinting a registration card must not produce a visibly different document.
  const a = await qrPngBuffer('https://innsight.example/portal/R-1');
  const b = await qrPngBuffer('https://innsight.example/portal/R-1');
  assert.ok(a.equals(b));
});
