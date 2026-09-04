const test = require('node:test');
const assert = require('node:assert');
const { buildMessage } = require('./notifier');

const BASE = { to: 'guest@example.test', from: 'hotel@example.test', subject: 'Hi' };

test('a message with no attachment stays plain text', () => {
  const msg = buildMessage({ ...BASE, body: 'Hello' });
  assert.match(msg, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(msg, /multipart/);
  assert.match(msg, /\r\n\r\nHello/, 'headers and body separated by a blank line');
});

test('headers carry the envelope', () => {
  const msg = buildMessage({ ...BASE, body: 'Hello' });
  assert.match(msg, /^From: hotel@example\.test\r\n/);
  assert.match(msg, /\r\nTo: guest@example\.test\r\n/);
  assert.match(msg, /\r\nSubject: Hi\r\n/);
  assert.match(msg, /\r\nMIME-Version: 1\.0\r\n/);
});

test('an attachment produces a multipart body with base64 content', () => {
  const pdf = Buffer.from('%PDF-1.4 hello');
  const msg = buildMessage({
    ...BASE,
    body: 'Your receipt is attached.',
    attachment: { filename: 'receipt.pdf', contentType: 'application/pdf', content: pdf },
  });
  assert.match(msg, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(msg, /Content-Disposition: attachment; filename="receipt\.pdf"/);
  assert.match(msg, /Content-Transfer-Encoding: base64/);
  assert.match(msg, new RegExp(pdf.toString('base64')));
  assert.match(msg, /Your receipt is attached\./, 'the text part survives alongside it');
});

test('the multipart body is closed with the final boundary', () => {
  // An unterminated multipart body makes the whole message unreadable to clients.
  const msg = buildMessage({
    ...BASE,
    body: 'x',
    attachment: { filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('x') },
  });
  const boundary = msg.match(/boundary="([^"]+)"/)[1];
  assert.match(msg, new RegExp(`--${boundary}--\r\n$`));
});

test('base64 is wrapped so no line exceeds the SMTP limit', () => {
  // RFC 5321 caps a line at 1000 octets including CRLF; a 1 MB PDF on one line is
  // silently mangled or rejected by a stricter server than Mailhog.
  const big = Buffer.alloc(9000, 0x41);
  const msg = buildMessage({
    ...BASE,
    body: 'x',
    attachment: { filename: 'big.pdf', contentType: 'application/pdf', content: big },
  });
  const longest = Math.max(...msg.split('\r\n').map((l) => l.length));
  assert.ok(longest <= 998, `longest line was ${longest}`);
});

test('a line consisting of a single dot is escaped', () => {
  // A bare "." on its own line ends an SMTP DATA block. Unescaped, a body
  // containing one truncates the message at that point and the rest is
  // interpreted as SMTP commands.
  const msg = buildMessage({ ...BASE, body: 'one\r\n.\r\ntwo' });
  assert.match(msg, /\r\n\.\.\r\n/);
  assert.doesNotMatch(msg, /\r\n\.\r\n/);
});

test('a leading dot on a longer line is also escaped', () => {
  const msg = buildMessage({ ...BASE, body: '.hidden config' });
  assert.match(msg, /\r\n\r\n\.\.hidden config/);
});
