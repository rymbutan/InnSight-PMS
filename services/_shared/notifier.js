// Lightweight email notifier — speaks SMTP directly to Mailhog (or any SMTP
// host). No nodemailer dependency on purpose: Mailhog accepts unauthenticated,
// unencrypted SMTP, so a tiny socket dialogue is plenty for a capstone.
//
// In production, replace with nodemailer + a real provider (Resend, SendGrid).

const net = require('node:net');

const SMTP_HOST = process.env.SMTP_HOST || 'mailhog';
const SMTP_PORT = Number(process.env.SMTP_PORT || 1025);
const FROM_ADDR = process.env.NOTIFY_FROM || 'no-reply@innsight.local';
const PORTAL_URL = (process.env.PORTAL_URL || 'http://localhost:5180').replace(/\/$/, '');

function send({ to, subject, body, from = FROM_ADDR }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: SMTP_HOST, port: SMTP_PORT });
    let buffer = '';
    let queue = [
      `HELO innsight\r\n`,
      `MAIL FROM:<${from}>\r\n`,
      `RCPT TO:<${to}>\r\n`,
      `DATA\r\n`,
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n.\r\n`,
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
      `View or change your booking: ${PORTAL_URL}/portal/${r.confirmationNumber}`,
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

module.exports = { send, TEMPLATES };
