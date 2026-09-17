// The SMTP dialogue itself, against a fake server on a real socket.
//
// buildMessage() is covered next door in notifier.test.js — that is the message
// FORMAT. This is the CONVERSATION, which is the half that changed when the
// notifier learned to authenticate, and the half that cannot be checked by
// reading the file: whether EHLO is repeated after the upgrade, whether the
// password is base64 in the right order, and — the one that matters most —
// whether a server that does not offer STARTTLS gets the credential anyway.
//
// A real net.Server rather than a mocked socket. The bugs worth catching here
// are protocol sequencing bugs, and a mock that replies to whatever it is sent
// cannot have a sequence to get wrong.
//
//   node --test src/lib/notifierSmtp.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

// Records the conversation and replies from a script. `caps` are the EHLO
// continuation lines, which is how a server announces (or withholds) STARTTLS.
function fakeSmtp({ caps = [], onLine } = {}) {
  const received = [];
  const server = net.createServer((sock) => {
    sock.write('220 fake ESMTP\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\r\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        received.push(line);
        const reply = onLine ? onLine(line, received) : null;
        if (reply) sock.write(reply);
        else if (/^EHLO/i.test(line)) {
          for (const c of caps) sock.write(`250-${c}\r\n`);
          sock.write('250 OK\r\n');
        } else if (/^MAIL FROM|^RCPT TO/i.test(line)) sock.write('250 OK\r\n');
        else if (/^DATA/i.test(line)) sock.write('354 Send it\r\n');
        else if (line === '.') sock.write('250 Queued\r\n');
        else if (/^QUIT/i.test(line)) sock.write('221 Bye\r\n');
        nl = buf.indexOf('\r\n');
      }
    });
    sock.on('error', () => {
      /* the client hangs up on refusal; not a test failure */
    });
  });
  return { server, received };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The module reads its configuration at require time, so each scenario needs a
// fresh copy with different environment.
function loadNotifier(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[require.resolve('./notifier')];
  delete require.cache[require.resolve('./publicUrl')];
  return require('./notifier');
}

// Every variable the module reads is listed here, INCLUDING the ones a given
// test does not care about. loadNotifier sets process.env, so anything omitted
// leaks from whichever test ran last — which is how the notice test started
// seeing the previous test's NOTIFY_REPLY_TO and asserting against the wrong
// branch.
const BASE = {
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  SMTP_SECURE: undefined,
  NOTIFY_REPLY_TO: undefined,
  SMTP_TIMEOUT_MS: 3000,
  NOTIFY_FROM: 'no-reply@innsight.local',
};

test('without credentials it behaves exactly as before — no AUTH, no STARTTLS', async () => {
  const { server, received } = fakeSmtp({ caps: ['STARTTLS', 'AUTH LOGIN'] });
  const port = await listen(server);
  try {
    const { send } = loadNotifier({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    const res = await send({ to: 'a@b.test', subject: 'Hi', body: 'Body' });
    assert.deepEqual(res, { ok: true });

    // Even though this server OFFERS both, an unauthenticated session must not
    // reach for them — that is the Mailhog path and it has to stay unchanged.
    assert.ok(!received.some((l) => /^STARTTLS/i.test(l)), 'must not attempt STARTTLS without credentials');
    assert.ok(!received.some((l) => /^AUTH/i.test(l)), 'must not attempt AUTH without credentials');
    assert.ok(received.some((l) => l === 'MAIL FROM:<no-reply@innsight.local>'));
    assert.ok(received.some((l) => l === 'RCPT TO:<a@b.test>'));
    assert.ok(received.includes('QUIT'));
  } finally {
    server.close();
  }
});

test('a server that refuses the recipient fails with the stage and the code', async () => {
  const { server } = fakeSmtp({
    onLine: (line) => (/^RCPT TO/i.test(line) ? '550 No such mailbox\r\n' : null),
  });
  const port = await listen(server);
  try {
    const { send } = loadNotifier({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    await assert.rejects(send({ to: 'nobody@b.test', subject: 'x', body: 'y' }), (err) => {
      assert.match(err.message, /SMTP 550/);
      assert.match(err.message, /RCPT TO/, 'the error must name the stage it failed at');
      return true;
    });
  } finally {
    server.close();
  }
});

test('a 4xx is surfaced too, not treated as success', async () => {
  const { server } = fakeSmtp({
    onLine: (line) => (/^MAIL FROM/i.test(line) ? '451 Try again later\r\n' : null),
  });
  const port = await listen(server);
  try {
    const { send } = loadNotifier({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    await assert.rejects(send({ to: 'a@b.test', subject: 'x', body: 'y' }), /SMTP 451/);
  } finally {
    server.close();
  }
});

test('credentials against a server with no STARTTLS are REFUSED, not downgraded', async () => {
  // The important one. A plaintext server plus a configured password must never
  // end with the password on the wire — an email that does not send is a far
  // better outcome than a leaked mailbox credential.
  const { server, received } = fakeSmtp({ caps: ['AUTH LOGIN'] }); // no STARTTLS offered
  const port = await listen(server);
  try {
    const { send } = loadNotifier({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      SMTP_USER: 'innsight.local.pms@gmail.com',
      SMTP_PASS: 'super-secret-app-password',
    });
    await assert.rejects(send({ to: 'a@b.test', subject: 'x', body: 'y' }), /STARTTLS/i);

    const wire = received.join('\n');
    assert.ok(!wire.includes('super-secret-app-password'), 'the raw password must never be written');
    assert.ok(
      !wire.includes(Buffer.from('super-secret-app-password', 'utf8').toString('base64')),
      'the base64 password must never be written either'
    );
    assert.ok(!received.some((l) => /^AUTH/i.test(l)), 'AUTH must not even be started');
  } finally {
    server.close();
  }
});

test('credentials against a STARTTLS server upgrade the connection', async () => {
  const { server, received } = fakeSmtp({ caps: ['STARTTLS', 'AUTH LOGIN'] });
  const port = await listen(server);
  try {
    const { send } = loadNotifier({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      SMTP_USER: 'u@gmail.com',
      SMTP_PASS: 'p',
    });
    // The fake server speaks no real TLS, so the handshake after the 220 fails.
    // That is fine and is the point: what is asserted is that STARTTLS was
    // requested BEFORE anything sensitive was sent, and that the failure is
    // reported rather than swallowed.
    await assert.rejects(send({ to: 'a@b.test', subject: 'x', body: 'y' }));
    assert.ok(
      received.some((l) => /^STARTTLS$/i.test(l)),
      'STARTTLS must be requested'
    );
    const beforeTls = received.slice(
      0,
      received.findIndex((l) => /^STARTTLS$/i.test(l))
    );
    assert.ok(!beforeTls.some((l) => /^AUTH/i.test(l)), 'AUTH must come after the upgrade, never before');
    assert.ok(!beforeTls.some((l) => /^MAIL FROM/i.test(l)), 'the envelope must wait for the upgrade too');
  } finally {
    server.close();
  }
});

test('multi-line capability replies are parsed, not mistaken for several replies', async () => {
  // "250-STARTTLS" then "250 OK" is ONE reply. Treating each line as final
  // walks the conversation two steps ahead of the server and every later
  // command lands on the wrong reply.
  const { server, received } = fakeSmtp({ caps: ['SIZE 35882577', 'PIPELINING', 'STARTTLS', 'AUTH LOGIN'] });
  const port = await listen(server);
  try {
    const { send } = loadNotifier({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    await send({ to: 'a@b.test', subject: 'x', body: 'y' });
    // One EHLO, one MAIL FROM — not one per capability line.
    assert.equal(received.filter((l) => /^EHLO/i.test(l)).length, 1);
    assert.equal(received.filter((l) => /^MAIL FROM/i.test(l)).length, 1);
  } finally {
    server.close();
  }
});

// ── No-reply handling ───────────────────────────────────────────────────────
// A mailbox cannot refuse replies — there is no header and no Gmail setting for
// it. What the system can do is SAY so and, where there is a monitored address,
// point replies at it. These pin both halves.

test('with no Reply-To configured, messages are marked auto-generated and say so', async () => {
  const { server, received } = fakeSmtp();
  const port = await listen(server);
  try {
    const { send } = loadNotifier({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      NOTIFY_REPLY_TO: undefined,
      NOTIFY_FROM: 'InnSight PMS (do not reply) <innsight.local.pms@gmail.com>',
    });
    await send({ to: 'a@b.test', subject: 'Reset your password', body: 'Open this link.' });

    const wire = received.join('\n');
    assert.match(wire, /^From: InnSight PMS \(do not reply\) <innsight\.local\.pms@gmail\.com>$/m);
    assert.match(wire, /^Auto-Submitted: auto-generated$/m);
    assert.doesNotMatch(wire, /^Reply-To:/m, 'an empty Reply-To is worse than none');
    assert.match(wire, /do not reply to it/i, 'the body must tell the reader not to reply');
  } finally {
    server.close();
  }
});

test('with a Reply-To configured, replies are pointed at it instead', async () => {
  const { server, received } = fakeSmtp();
  const port = await listen(server);
  try {
    const { send } = loadNotifier({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      NOTIFY_REPLY_TO: 'frontdesk@slsu.edu.ph',
    });
    await send({ to: 'a@b.test', subject: 'Reset your password', body: 'Open this link.' });

    const wire = received.join('\n');
    assert.match(wire, /^Reply-To: frontdesk@slsu\.edu\.ph$/m);
    // Auto-Submitted is for mail nobody reads. With a monitored reply address
    // this IS a conversation, and marking it auto-generated tells list software
    // to discard the reply.
    assert.doesNotMatch(wire, /^Auto-Submitted:/m);
    assert.match(wire, /Replies go to frontdesk@slsu\.edu\.ph/);
    assert.doesNotMatch(wire, /do not reply to it/i);
  } finally {
    server.close();
  }
});

test('the notice is appended to the body, never to the headers', async () => {
  // A footer that lands above the blank line separating headers from body would
  // corrupt the message rather than annotate it.
  const { server, received } = fakeSmtp();
  const port = await listen(server);
  try {
    const { send } = loadNotifier({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    await send({ to: 'a@b.test', subject: 'S', body: 'THE-BODY' });
    const wire = received.join('\n');
    const blankLine = wire.indexOf('\n\n');
    assert.ok(blankLine > 0, 'message must have a header/body separator');
    assert.ok(
      wire.indexOf('do not reply to it') > blankLine,
      'the notice must sit in the body, after the headers'
    );
    assert.ok(wire.indexOf('THE-BODY') < wire.indexOf('do not reply to it'), 'notice goes last');
  } finally {
    server.close();
  }
});

// ── Envelope vs header addresses ────────────────────────────────────────────
// A display name is legal in the From HEADER (RFC 5322) and illegal in the
// MAIL FROM ENVELOPE (RFC 5321). Sending the header form as the envelope
// produced `MAIL FROM:<InnSight PMS (do not reply) <a@b>>`, which Mailhog and
// every 250-to-everything fake accepts and Gmail rejects with 555 5.5.2. It got
// as far as a live send before anything noticed, so these assert the WIRE.

test('a display name is stripped from the envelope but kept in the header', async () => {
  const { server, received } = fakeSmtp();
  const port = await listen(server);
  try {
    const { send } = loadNotifier({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      NOTIFY_FROM: 'InnSight PMS (do not reply) <innsight.local.pms@gmail.com>',
    });
    await send({ to: 'fsalvanera@slsu.edu.ph', subject: 'S', body: 'B' });

    assert.ok(
      received.includes('MAIL FROM:<innsight.local.pms@gmail.com>'),
      `envelope must be a bare address, got: ${received.find((l) => l.startsWith('MAIL FROM'))}`
    );
    assert.ok(received.includes('RCPT TO:<fsalvanera@slsu.edu.ph>'));
    // The header keeps the name — that is the whole point of setting one.
    assert.match(
      received.join('\n'),
      /^From: InnSight PMS \(do not reply\) <innsight\.local\.pms@gmail\.com>$/m
    );
  } finally {
    server.close();
  }
});

test('a nested angle bracket never reaches the envelope', async () => {
  // The precise shape Gmail refused.
  const { server, received } = fakeSmtp();
  const port = await listen(server);
  try {
    const { send } = loadNotifier({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      NOTIFY_FROM: 'Name <a@b.test>',
    });
    await send({ to: 'Someone <c@d.test>', subject: 'S', body: 'B' });
    for (const line of received.filter((l) => /^(MAIL FROM|RCPT TO)/.test(l))) {
      assert.ok(!/<[^>]*</.test(line), `nested angle brackets in the envelope: ${line}`);
    }
  } finally {
    server.close();
  }
});

test('envelopeAddress handles the forms that actually occur', () => {
  const { envelopeAddress } = loadNotifier({ ...BASE });
  assert.equal(envelopeAddress('a@b.com'), 'a@b.com');
  assert.equal(envelopeAddress('Name <a@b.com>'), 'a@b.com');
  assert.equal(envelopeAddress('InnSight PMS (do not reply) <a@b.com>'), 'a@b.com');
  assert.equal(envelopeAddress('  <a@b.com>  '), 'a@b.com');
  assert.equal(envelopeAddress(''), '');
});
