// Lightweight email notifier — speaks SMTP directly to Mailhog (or any SMTP
// host). No nodemailer dependency on purpose: Mailhog accepts unauthenticated,
// unencrypted SMTP, so a tiny socket dialogue is plenty for a capstone.
//
// In production, replace with nodemailer + a real provider (Resend, SendGrid).

const net = require('node:net');

const SMTP_HOST = process.env.SMTP_HOST || 'mailhog';
const SMTP_PORT = Number(process.env.SMTP_PORT || 1025);
const FROM_ADDR = process.env.NOTIFY_FROM || 'no-reply@innsight.local';
// Guest-facing links come from the shared publicUrl helper so there is one answer
// to "what address can the guest actually reach?" rather than a per-module guess.
// The old default here was port 5180 — the gateway's second published port — which
// worked but disagreed with everything else in the stack.
const { publicUrl } = require('./publicUrl');

// SMTP dot-stuffing. A line that is exactly "." terminates a DATA block, so any
// body line starting with one must be doubled or the message is truncated there
// and the remainder is fed to the server as commands. Applies to attachment
// base64 too — unlikely to start with a dot, but not worth reasoning about.
function dotStuff(text) {
  return text.replace(/(^|\r\n)\./g, '$1..');
}

// Base64 wrapped to 76 columns. RFC 5321 caps a line at 1000 octets including
// CRLF, so a multi-hundred-kilobyte PDF emitted as one line is mangled or rejected
// by any server stricter than Mailhog.
function wrapBase64(buf) {
  return (buf.toString('base64').match(/.{1,76}/g) || []).join('\r\n');
}

/**
 * The RFC 5322 message — headers plus body — ready to go inside a DATA block.
 * The caller appends the terminating "\r\n.\r\n".
 *
 * Split out of send() so the message format can be unit-tested without a socket,
 * and so attachments could be added at all: the original inlined a fixed
 * `Content-Type: text/plain` header, which is why the system could email a guest
 * about a booking but could not send them the receipt PDF.
 *
 * @param {object} [attachment] { filename, contentType, content: Buffer }
 */
function buildMessage({ to, subject, body, from = FROM_ADDR, attachment }) {
  const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0'];

  if (!attachment) {
    return `${headers.join('\r\n')}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${dotStuff(body)}`;
  }

  // Boundary must not appear in either part. A random suffix is enough here and
  // avoids scanning the payload for a collision.
  const boundary = `innsight-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    dotStuff(body),
    `--${boundary}`,
    `Content-Type: ${attachment.contentType || 'application/octet-stream'}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    dotStuff(wrapBase64(attachment.content)),
    `--${boundary}--`,
    '',
  ];

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

function send({ to, subject, body, from = FROM_ADDR, attachment }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: SMTP_HOST, port: SMTP_PORT });
    let buffer = '';
    let queue = [
      `HELO innsight\r\n`,
      `MAIL FROM:<${from}>\r\n`,
      `RCPT TO:<${to}>\r\n`,
      `DATA\r\n`,
      `${buildMessage({ to, subject, body, from, attachment })}\r\n.\r\n`,
      `QUIT\r\n`,
    ];

    function next() {
      if (queue.length === 0) return;
      sock.write(queue.shift());
    }

    sock.setTimeout(5000);
    sock.on('timeout', () => {
      sock.destroy(new Error('SMTP timeout'));
      reject(new Error('SMTP timeout'));
    });
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const line = buffer.slice(0, buffer.indexOf('\r\n'));
        buffer = buffer.slice(buffer.indexOf('\r\n') + 2);
        if (/^\d{3} /.test(line)) {
          if (line.startsWith('5')) {
            sock.destroy();
            return reject(new Error(line));
          }
          next();
          if (line.startsWith('221')) {
            sock.end();
            return resolve({ ok: true });
          }
        }
      }
    });
  });
}

const TEMPLATES = {
  reservation_confirmed: (r) => ({
    subject: `Booking confirmed — ${r.confirmationNumber}`,
    body: [
      `Hi ${r.guestName || 'guest'},`,
      ``,
      `Thank you for booking with InnSight Hotel! Your reservation is confirmed.`,
      ``,
      `  Confirmation: ${r.confirmationNumber}`,
      `  Check-in:     ${new Date(r.checkIn).toDateString()}`,
      `  Check-out:    ${new Date(r.checkOut).toDateString()}`,
      ``,
      `View or change your booking: ${publicUrl(`/portal/${r.confirmationNumber}`)}`,
      ``,
      `See you soon,`,
      `The InnSight Team`,
    ].join('\n'),
  }),
  reservation_cancelled: (r) => ({
    subject: `Booking cancelled — ${r.confirmationNumber}`,
    body: [
      `Hi ${r.guestName || 'guest'},`,
      ``,
      `Your reservation ${r.confirmationNumber} has been cancelled.`,
      r.cancellationFeeCents
        ? `A cancellation fee of ₱${(Number(r.cancellationFeeCents) / 100).toFixed(2)} applies.`
        : '',
      ``,
      `If this was a mistake, please contact the front desk.`,
      ``,
      `— InnSight`,
    ]
      .filter(Boolean)
      .join('\n'),
  }),
  check_in_reminder: (r) => ({
    subject: `Your stay starts tomorrow — ${r.confirmationNumber}`,
    body: [
      `Hi ${r.guestName || 'guest'},`,
      ``,
      `Just a friendly reminder that your stay at InnSight begins tomorrow.`,
      `  Check-in:  ${new Date(r.checkIn).toDateString()} from 2:00 PM`,
      `  Check-out: ${new Date(r.checkOut).toDateString()} by 12:00 PM`,
      ``,
      `— InnSight`,
    ].join('\n'),
  }),
};

module.exports = { send, buildMessage, TEMPLATES };
