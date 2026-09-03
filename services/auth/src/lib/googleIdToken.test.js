const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyGoogleIdToken, _resetCertCache } = require('./googleIdToken');

// A throwaway RSA pair standing in for Google's signing key, so the domain rule
// can be tested for real — signature and all — without a network call.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const KID = 'test-kid';
const CLIENT_ID = 'innsight-test.apps.googleusercontent.com';
const DOMAIN = 'slsu.edu.ph';

const realFetch = global.fetch;
function stubCerts() {
  _resetCertCache();
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ [KID]: PEM }),
    headers: { get: () => 'max-age=0' },
  });
}
function restore() {
  global.fetch = realFetch;
  _resetCertCache();
}

const sign = (claims, kid = KID) =>
  jwt.sign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      email_verified: true,
      name: 'Test Student',
      sub: '1234567890',
      ...claims,
    },
    privateKey,
    { algorithm: 'RS256', expiresIn: '5m', keyid: kid }
  );

const verify = (token) => verifyGoogleIdToken(token, { clientId: CLIENT_ID, allowedDomain: DOMAIN });

test('a verified @slsu.edu.ph account is accepted', async () => {
  stubCerts();
  try {
    const p = await verify(sign({ email: 'juan.delacruz@slsu.edu.ph', hd: 'slsu.edu.ph' }));
    assert.equal(p.email, 'juan.delacruz@slsu.edu.ph');
    assert.equal(p.name, 'Test Student');
  } finally {
    restore();
  }
});

test('the address is lower-cased, so casing cannot create a second identity', async () => {
  stubCerts();
  try {
    const p = await verify(sign({ email: 'Juan.DelaCruz@SLSU.edu.ph' }));
    assert.equal(p.email, 'juan.delacruz@slsu.edu.ph');
  } finally {
    restore();
  }
});

test('a personal gmail account is refused', async () => {
  stubCerts();
  try {
    await assert.rejects(verify(sign({ email: 'someone@gmail.com' })), /Only @slsu\.edu\.ph accounts/);
  } finally {
    restore();
  }
});

test('a lookalike domain is refused', async () => {
  stubCerts();
  try {
    // The suffix check must not be fooled by a domain that merely ENDS with the
    // allowed one, nor by one that contains it.
    await assert.rejects(verify(sign({ email: 'a@notslsu.edu.ph' })), /Only @slsu\.edu\.ph/);
    await assert.rejects(verify(sign({ email: 'a@slsu.edu.ph.evil.com' })), /Only @slsu\.edu\.ph/);
  } finally {
    restore();
  }
});

test('a right-looking address on another Workspace tenant is refused', async () => {
  stubCerts();
  try {
    await assert.rejects(
      verify(sign({ email: 'staff@slsu.edu.ph', hd: 'someoneelse.com' })),
      /Only @slsu\.edu\.ph/
    );
  } finally {
    restore();
  }
});

test('an unverified email is refused even inside the domain', async () => {
  stubCerts();
  try {
    await assert.rejects(verify(sign({ email: 'x@slsu.edu.ph', email_verified: false })), /unverified email/);
  } finally {
    restore();
  }
});

test('a token minted for a different client id is refused', async () => {
  stubCerts();
  try {
    await assert.rejects(verify(sign({ email: 'x@slsu.edu.ph', aud: 'someone-else' })), /audience/i);
  } finally {
    restore();
  }
});

test('a token from the wrong issuer is refused', async () => {
  stubCerts();
  try {
    await assert.rejects(verify(sign({ email: 'x@slsu.edu.ph', iss: 'https://evil.example' })), /issuer/i);
  } finally {
    restore();
  }
});

test('a token signed by an unknown key is refused', async () => {
  stubCerts();
  try {
    await assert.rejects(
      verify(sign({ email: 'x@slsu.edu.ph' }, 'some-other-kid')),
      /not signed by a recognised key/
    );
  } finally {
    restore();
  }
});

test('a token signed by the WRONG key is refused', async () => {
  stubCerts();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  try {
    const forged = jwt.sign(
      { iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'x@slsu.edu.ph', email_verified: true },
      other.privateKey,
      { algorithm: 'RS256', expiresIn: '5m', keyid: KID }
    );
    await assert.rejects(verify(forged), /signature/i);
  } finally {
    restore();
  }
});

test('an expired token is refused', async () => {
  stubCerts();
  try {
    const stale = jwt.sign(
      { iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'x@slsu.edu.ph', email_verified: true },
      privateKey,
      { algorithm: 'RS256', expiresIn: '-1m', keyid: KID }
    );
    await assert.rejects(verify(stale), /expired/i);
  } finally {
    restore();
  }
});

test('no client id configured is a server error, not an open door', async () => {
  stubCerts();
  try {
    await assert.rejects(
      verifyGoogleIdToken(sign({ email: 'x@slsu.edu.ph' }), { clientId: '', allowedDomain: DOMAIN }),
      /not configured/
    );
  } finally {
    restore();
  }
});

// ── Access-token path (the custom-styled button) ─────────────────────────────
//
// The bearer nature of an access token makes the `aud` check the whole ballgame:
// without it, a token minted for any other Google app would sign someone in here.

const { verifyGoogleAccessToken } = require('./googleIdToken');

function stubGoogle({ tokeninfo, userinfo, tokeninfoOk = true, userinfoOk = true }) {
  global.fetch = async (url) => {
    if (String(url).includes('tokeninfo')) {
      return { ok: tokeninfoOk, json: async () => tokeninfo };
    }
    return { ok: userinfoOk, json: async () => userinfo };
  };
}

const verifyAt = (t = 'tok') => verifyGoogleAccessToken(t, { clientId: CLIENT_ID, allowedDomain: DOMAIN });

test('access token: a verified @slsu.edu.ph account is accepted', async () => {
  stubGoogle({
    tokeninfo: { aud: CLIENT_ID, email: 'maria@slsu.edu.ph' },
    userinfo: { email: 'maria@slsu.edu.ph', email_verified: true, hd: 'slsu.edu.ph', name: 'Maria' },
  });
  try {
    const p = await verifyAt();
    assert.equal(p.email, 'maria@slsu.edu.ph');
    assert.equal(p.name, 'Maria');
  } finally {
    restore();
  }
});

test('access token: a token issued to another app is refused', async () => {
  stubGoogle({
    tokeninfo: { aud: 'some-other-app.apps.googleusercontent.com', email: 'x@slsu.edu.ph' },
    userinfo: { email: 'x@slsu.edu.ph', email_verified: true },
  });
  try {
    await assert.rejects(verifyAt(), /issued for a different application/);
  } finally {
    restore();
  }
});

test('access token: a personal gmail account is refused', async () => {
  stubGoogle({
    tokeninfo: { aud: CLIENT_ID },
    userinfo: { email: 'someone@gmail.com', email_verified: true },
  });
  try {
    await assert.rejects(verifyAt(), /Only @slsu\.edu\.ph/);
  } finally {
    restore();
  }
});

test('access token: a lookalike domain is refused', async () => {
  stubGoogle({
    tokeninfo: { aud: CLIENT_ID },
    userinfo: { email: 'a@slsu.edu.ph.evil.com', email_verified: true },
  });
  try {
    await assert.rejects(verifyAt(), /Only @slsu\.edu\.ph/);
  } finally {
    restore();
  }
});

test('access token: a foreign Workspace tenant is refused', async () => {
  stubGoogle({
    tokeninfo: { aud: CLIENT_ID },
    userinfo: { email: 'staff@slsu.edu.ph', email_verified: true, hd: 'elsewhere.com' },
  });
  try {
    await assert.rejects(verifyAt(), /Only @slsu\.edu\.ph/);
  } finally {
    restore();
  }
});

test('access token: an unverified email is refused', async () => {
  stubGoogle({
    tokeninfo: { aud: CLIENT_ID },
    userinfo: { email: 'x@slsu.edu.ph', email_verified: false },
  });
  try {
    await assert.rejects(verifyAt(), /unverified email/);
  } finally {
    restore();
  }
});

test('access token: an expired or revoked token is refused', async () => {
  stubGoogle({ tokeninfo: {}, tokeninfoOk: false, userinfo: {} });
  try {
    await assert.rejects(verifyAt(), /rejected/);
  } finally {
    restore();
  }
});
