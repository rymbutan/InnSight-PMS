// Object storage for payment proof documents — deposit slips and bank
// confirmation screenshots attached to a BANK_TRANSFER payment.
//
// Files never touch Postgres: only their metadata does (see the
// PaymentDocument model). The bytes live in MinIO, addressed by an opaque
// object key the row remembers — the same split the print/receipt PDFs use
// between "the document" and "what generated it", just for uploaded files
// instead of generated ones. Mirrors services/reservation/src/lib/storage.js
// byte for byte, in its own bucket.
//
// One root credential, not a scoped IAM user: this is a non-PCI-compliant
// capstone build, and MinIO is reachable only from inside the compose
// network, never from a browser — the same trust boundary every other
// service already crosses with its own DATABASE_URL.

const { Client } = require('minio');
const crypto = require('node:crypto');

const BUCKET = process.env.MINIO_BUCKET || 'folio-payment-proofs';

const client = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || '',
  secretKey: process.env.MINIO_SECRET_KEY || '',
});

// Called once at startup. Idempotent — `bucketExists` is what makes a second
// container boot a no-op instead of an error, same discipline as this
// service's SQL migrations.
async function ensureBucket() {
  if (!(await client.bucketExists(BUCKET).catch(() => false))) {
    await client.makeBucket(BUCKET);
  }
}

// A key that cannot collide across payments or uploads, and that keeps a
// payment's proof grouped when a bucket is browsed by hand.
function objectKeyFor(paymentId, filename) {
  const safe = String(filename || 'file')
    .replace(/[^\w.-]/g, '_')
    .slice(-120);
  return `payments/${paymentId}/${crypto.randomUUID()}-${safe}`;
}

// Evidence attached to a charge dispute/void (e.g. a screenshot of the guest
// conversation an auditor cited) — same bucket as payment proofs, a
// different prefix so the two don't intermix when the bucket is browsed by
// hand. Keyed to the transaction being disputed, not the reversal it
// produces, since that is the row a person is asking "why was this voided?"
// about.
function objectKeyForDispute(transactionId, filename) {
  const safe = String(filename || 'file')
    .replace(/[^\w.-]/g, '_')
    .slice(-120);
  return `disputes/${transactionId}/${crypto.randomUUID()}-${safe}`;
}

async function putDocument(objectKey, buffer, contentType) {
  await client.putObject(BUCKET, objectKey, buffer, buffer.length, {
    'Content-Type': contentType || 'application/octet-stream',
  });
}

// Returns a readable stream — callers pipe it straight to the HTTP response
// rather than buffering a whole file in memory twice.
async function getDocumentStream(objectKey) {
  return client.getObject(BUCKET, objectKey);
}

async function removeDocument(objectKey) {
  await client.removeObject(BUCKET, objectKey);
}

module.exports = {
  ensureBucket,
  objectKeyFor,
  objectKeyForDispute,
  putDocument,
  getDocumentStream,
  removeDocument,
  BUCKET,
};
