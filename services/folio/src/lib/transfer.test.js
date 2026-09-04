const test = require('node:test');
const assert = require('node:assert');
const { planTransfer } = require('./transfer');

const TX = {
  id: 'tx1',
  folioId: 'A',
  type: 'CHARGE',
  chargeCode: 'MB',
  description: 'Minibar',
  amountCents: 15000n,
  taxAmountCents: 1800n,
  quantity: 1,
};
const OPTS = { fromFolioId: 'A', toFolioId: 'B', folioNumbers: { A: 'F-1', B: 'F-2' } };

test('a transfer nets to zero across the two folios', () => {
  const [out, into] = planTransfer(TX, OPTS);
  assert.equal(out.folioId, 'A');
  assert.equal(into.folioId, 'B');
  assert.equal(out.amountCents + into.amountCents, 0n);
  assert.equal(out.taxAmountCents + into.taxAmountCents, 0n);
});

test('the tax rides with the charge, not left behind on the source folio', () => {
  const [out, into] = planTransfer(TX, OPTS);
  assert.equal(out.taxAmountCents, -1800n);
  assert.equal(into.taxAmountCents, 1800n);
});

test('both rows are TRANSFER and name the other folio', () => {
  const [out, into] = planTransfer(TX, OPTS);
  assert.equal(out.type, 'TRANSFER');
  assert.equal(into.type, 'TRANSFER');
  assert.match(out.description, /F-2/, 'the source line must say where it went');
  assert.match(into.description, /F-1/, 'the destination line must say where it came from');
  assert.equal(out.reversalOf, 'tx1');
  assert.equal(into.reversalOf, 'tx1');
});

test('the charge code is preserved so revenue stays classified', () => {
  // A minibar charge moved to a company folio is still F&B revenue. Dropping the
  // code here would quietly move the money into the unclassified bucket of every
  // report that keys off ChargeCode.category.
  const [out, into] = planTransfer(TX, OPTS);
  assert.equal(out.chargeCode, 'MB');
  assert.equal(into.chargeCode, 'MB');
});

test('transferring to the same folio is refused', () => {
  assert.throws(() => planTransfer(TX, { ...OPTS, toFolioId: 'A' }), /same folio/i);
});

test('a negative amount transfers correctly too', () => {
  // A credit adjustment can be moved as legitimately as a charge; the pair must
  // still net to zero rather than doubling the credit.
  const credit = { ...TX, amountCents: -5000n, taxAmountCents: 0n };
  const [out, into] = planTransfer(credit, OPTS);
  assert.equal(out.amountCents, 5000n);
  assert.equal(into.amountCents, -5000n);
  assert.equal(out.amountCents + into.amountCents, 0n);
});

test('string amounts from JSON are coerced, not concatenated', () => {
  const fromJson = { ...TX, amountCents: '15000', taxAmountCents: '1800' };
  const [out, into] = planTransfer(fromJson, OPTS);
  assert.equal(out.amountCents, -15000n);
  assert.equal(into.amountCents, 15000n);
});
