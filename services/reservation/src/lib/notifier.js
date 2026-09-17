// Email notifier. Speaks SMTP over a socket — no nodemailer dependency, because
// this file is vendored into three services and a new runtime dependency means
// three package.json files and three lockfiles kept in step for a dialogue that
// is a dozen lines of protocol.
//
// TWO MODES, ONE CODE PATH
// ------------------------
// Development talks to Mailhog: no credentials, no encryption, everything
// captured and nothing delivered. Production talks to a real provider, which
// means STARTTLS and AUTH before it will accept a single byte of mail.
//
// The switch is CREDENTIALS, not a mode flag: set SMTP_USER and SMTP_PASS and
// the session upgrades to TLS and authenticates; leave them unset and it behaves
// exactly as it always did. There is no configuration in which this sends a
// password over a plaintext socket — if credentials are present, STARTTLS is
// mandatory and a server that will not offer it is an error rather than a
// silent downgrade.
//
// GMAIL, SPECIFICALLY
// -------------------
// smtp.gmail.com:587 with STARTTLS. The password is an APP PASSWORD (Google
// account → Security → 2-Step Verification → App passwords), not the account
// password — Google stopped accepting the latter over SMTP in May 2022. The
// From address must be the authenticated mailbox or Gmail silently rewrites it,
// which is why NOTIFY_FROM and SMTP_USER should name the same account.

const net = require('node:net');
const tls = require('node:tls');

const SMTP_HOST = process.env.SMTP_HOST || 'mailhog';
const SMTP_PORT = Number(process.env.SMTP_PORT || 1025);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// Implicit TLS from the first byte (port 465). Most providers, Gmail included,
// prefer STARTTLS on 587; this is here for the ones that only offer 465.
const SMTP_IMPLICIT_TLS = String(process.env.SMTP_SECURE || '').toLowerCase() === 'tls' || SMTP_PORT === 465;
const SMTP_AUTH = Boolean(SMTP_USER && SMTP_PASS);
// Mailhog answers instantly on a local network. A real provider has a TLS
// handshake and an auth round trip to get through first, and 5s was tight
// enough to fail on a slow link — which would have looked like the mail
// silently not arriving, since the caller logs and swallows.
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || (SMTP_AUTH ? 20000 : 5000));
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

/**
 * One SMTP conversation, as an explicit list of steps.
 *
 * The previous version pushed every command into a queue and fired the next one
 * on any final-line reply. That works for a server which says yes to everything
 * in a fixed order, and it cannot express STARTTLS — where the socket itself is
 * replaced mid-conversation and the greeting has to be repeated on the new one.
 * Steps let each reply be checked against the code that reply is supposed to be,
 * so a refusal names the stage it happened at instead of surfacing as a generic
 * failure three commands later.
 */
function send({ to, subject, body, from = FROM_ADDR, attachment }) {
  return new Promise((resolve, reject) => {
    let socket = SMTP_IMPLICIT_TLS
      ? tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST })
      : net.createConnection({ host: SMTP_HOST, port: SMTP_PORT });

    let settled = false;
    let buffer = '';
    let caps = '';
    let steps = [];
    let awaiting = null;

    function fail(err) {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function done() {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* already gone */
      }
      resolve({ ok: true });
    }

    function write(line) {
      socket.write(line.endsWith('\r\n') ? line : `${line}\r\n`);
    }

    // Take the next step: send its command, if it has one, and record the reply
    // it expects. A step with no `send` only waits — the server greeting, and
    // the greeting again after a TLS upgrade.
    function advance() {
      const step = steps.shift();
      if (!step) return done();
      awaiting = step;
      if (step.send !== undefined) write(step.send);
      return undefined;
    }

    function onReply(code, text) {
      const step = awaiting;
      if (!step) return undefined;
      if (!step.codes.includes(code)) {
        // 4xx is "try later" and 5xx is "never". Neither changes what the caller
        // does — it logs and moves on — but the code belongs in the message so
        // the log says which of the two happened, and where.
        return fail(new Error(`SMTP ${code} at ${step.label}: ${text.trim()}`));
      }
      awaiting = null;
      if (step.then) return step.then(text);
      return advance();
    }

    // SMTP replies may be multi-line — "250-STARTTLS" then "250 HELP" — and only
    // the space form ends one. The continuation lines are accumulated because
    // the capability list is what says whether STARTTLS is on offer.
    function attach(sock) {
      sock.setTimeout(SMTP_TIMEOUT_MS);
      sock.on('timeout', () => fail(new Error(`SMTP timeout after ${SMTP_TIMEOUT_MS}ms`)));
      sock.on('error', fail);
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl = buffer.indexOf('\r\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          if (/^\d{3}-/.test(line)) {
            caps += `${line}\n`;
          } else if (/^\d{3}( |$)/.test(line)) {
            const code = Number(line.slice(0, 3));
            const all = caps + line;
            caps = '';
            onReply(code, all);
          }
          nl = buffer.indexOf('\r\n');
        }
      });
    }

    // Everything from MAIL FROM onwards is the same in every mode.
    function envelopeSteps() {
      return [
        { label: 'MAIL FROM', send: `MAIL FROM:<${from}>`, codes: [250] },
        { label: 'RCPT TO', send: `RCPT TO:<${to}>`, codes: [250, 251] },
        { label: 'DATA', send: 'DATA', codes: [354] },
        {
          label: 'message body',
          send: `${buildMessage({ to, subject, body, from, attachment })}\r\n.`,
          codes: [250],
        },
        { label: 'QUIT', send: 'QUIT', codes: [221], then: () => done() },
      ];
    }

    // AUTH LOGIN is a three-part exchange rather than one command, so it is
    // expressed as nested continuations instead of as three list entries.
    function authThenEnvelope() {
      if (!SMTP_AUTH) return envelopeSteps();
      return [
        {
          label: 'AUTH LOGIN',
          send: 'AUTH LOGIN',
          codes: [334],
          then: () => {
            awaiting = {
              label: 'AUTH username',
              codes: [334],
              then: () => {
                awaiting = {
                  label: 'AUTH password',
                  codes: [235],
                  then: () => advance(),
                };
                write(Buffer.from(SMTP_PASS, 'utf8').toString('base64'));
              },
            };
            write(Buffer.from(SMTP_USER, 'utf8').toString('base64'));
          },
        },
        ...envelopeSteps(),
      ];
    }

    function afterEhlo(text) {
      // No credentials: this is Mailhog or another open relay on a trusted
      // network, and the session stays exactly as it always was.
      if (!SMTP_AUTH || SMTP_IMPLICIT_TLS) {
        steps = authThenEnvelope();
        return advance();
      }
      if (!/STARTTLS/i.test(text)) {
        // Deliberately fatal. Carrying on would put SMTP_PASS on the wire in
        // the clear, and leaking the mailbox credential is a worse outcome than
        // an email that does not send.
        return fail(
          new Error(
            `SMTP server ${SMTP_HOST}:${SMTP_PORT} does not offer STARTTLS; refusing to send credentials in the clear`
          )
        );
      }
      steps = [
        {
          label: 'STARTTLS',
          send: 'STARTTLS',
          codes: [220],
          then: () => {
            const plain = socket;
            plain.removeAllListeners('data');
            plain.removeAllListeners('error');
            plain.removeAllListeners('timeout');
            buffer = '';
            caps = '';
            const secure = tls.connect({ socket: plain, servername: SMTP_HOST }, () => {
              // EHLO is repeated on the upgraded connection: the server discards
              // everything it told us before the upgrade, including AUTH.
              steps = [
                {
                  label: 'EHLO (TLS)',
                  send: 'EHLO innsight',
                  codes: [250],
                  then: () => {
                    steps = authThenEnvelope();
                    advance();
                  },
                },
              ];
              advance();
            });
            socket = secure;
            attach(secure);
          },
        },
      ];
      return advance();
    }

    steps = [];
    awaiting = {
      label: 'greeting',
      codes: [220],
      then: () => {
        steps = [{ label: 'EHLO', send: 'EHLO innsight', codes: [250], then: afterEhlo }];
        advance();
      },
    };

    attach(socket);
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
