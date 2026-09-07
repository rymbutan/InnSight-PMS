const test = require('node:test');
const assert = require('node:assert');
const { allocate, netRemaining, planSplit, splitNote } = require('./split');

// ── allocate ────────────────────────────────────────────────────────────────

test('an exact division needs no remainder handling', () => {
  assert.deepEqual(allocate(10000n, [50, 50]), [5000n, 5000n]);
  assert.deepEqual(allocate(9000n, [60, 40]), [5400n, 3600n]);
});

test('the leftover cents are handed out, so the parts sum to the total exactly', () => {
  // The case the whole method exists for: 100000 / 3 is not a whole number of
  // cents, and money that does not add back up is money invented or destroyed.
  const parts = allocate(100000n, [1, 1, 1]);
  // All three remainders tie, so the odd centavo goes to the earliest share.
  assert.deepEqual(parts, [33334n, 33333n, 33333n]);
  assert.equal(
    parts.reduce((a, b) => a + b, 0n),
    100000n
  );
});

test('every total sums back exactly, across awkward divisors', () => {
  // Sweeps every remainder class rather than picking a lucky total.
  for (const ways of [2, 3, 6, 7, 8]) {
    const shares = Array(ways).fill(1);
    for (let total = 0n; total < 200n; total++) {
      const parts = allocate(total, shares);
      assert.equal(
        parts.reduce((a, b) => a + b, 0n),
        total,
        `${total} split ${ways} ways must sum back to ${total}`
      );
      assert.equal(parts.length, ways);
    }
  }
});

test('uneven percentage shares also sum back exactly', () => {
  for (const shares of [
    [60, 40],
    [33.33, 33.33, 33.34],
    [1, 98, 1],
    [12.5, 12.5, 75],
  ]) {
    for (let total = 0n; total < 150n; total++) {
      const parts = allocate(total, shares);
      assert.equal(
        parts.reduce((a, b) => a + b, 0n),
        total,
        `${total} by [${shares}] must sum back to ${total}`
      );
    }
  }
});

test('the remainder goes to the largest fractional part, ties to the earliest share', () => {
  // 10 cents by [1,1,1]: 3.33 each. Two cents are left; both remainders tie, so
  // the first two shares take them. Deterministic placement matters — the same
  // split run twice has to produce identical folios.
  assert.deepEqual(allocate(10n, [1, 1, 1]), [4n, 3n, 3n]);
  assert.deepEqual(allocate(10n, [1, 1, 1]), allocate(10n, [1, 1, 1]));
});

test('a total smaller than the number of shares still sums back', () => {
  // Two of these payers legitimately owe nothing on this line.
  const parts = allocate(1n, [1, 1, 1]);
  assert.deepEqual(parts, [1n, 0n, 0n]);
  assert.equal(
    parts.reduce((a, b) => a + b, 0n),
    1n
  );
});

test('a zero total allocates nothing to anyone', () => {
  assert.deepEqual(allocate(0n, [70, 30]), [0n, 0n]);
});

test('a negative total (a credit line) splits as cleanly as a charge', () => {
  // A discount on the folio is money the payers share too. Rounding must not
  // turn -100 into -101.
  const parts = allocate(-100000n, [1, 1, 1]);
  assert.equal(
    parts.reduce((a, b) => a + b, 0n),
    -100000n
  );
  assert.deepEqual(parts, [-33334n, -33333n, -33333n]);
});

test('string and number totals from JSON are coerced, not concatenated', () => {
  assert.deepEqual(allocate('9000', [60, 40]), [5400n, 3600n]);
  assert.deepEqual(allocate(9000, [60, 40]), [5400n, 3600n]);
});

test('allocate refuses a share vector that cannot describe a split', () => {
  assert.throws(() => allocate(100n, []), /at least one share/i);
  assert.throws(() => allocate(100n, [0, 0]), /cannot all be zero/i);
  assert.throws(() => allocate(100n, [50, -10]), /negative/i);
});

// ── netRemaining ────────────────────────────────────────────────────────────

const CHARGE = {
  id: 'tx1',
  folioId: 'A',
  type: 'CHARGE',
  chargeCode: 'RM',
  description: 'Room',
  amountCents: 560000n,
  taxAmountCents: 67200n,
  quantity: 1,
};

test('an untouched charge has its whole face value remaining', () => {
  const net = netRemaining(CHARGE, [CHARGE]);
  assert.equal(net.amountCents, 560000n);
  assert.equal(net.taxAmountCents, 67200n);
});

test('a charge already split has only the unsplit part remaining', () => {
  // This is what makes a folio splittable twice. After a 60/40 split the CHARGE
  // row still reads 5,600 with a -2,240 transfer beside it; a second split must
  // divide 3,360, not 5,600, or it moves money that is no longer there.
  const rows = [
    CHARGE,
    {
      id: 'tx2',
      folioId: 'A',
      type: 'TRANSFER',
      reversalOf: 'tx1',
      amountCents: -224000n,
      taxAmountCents: -26880n,
    },
  ];
  const net = netRemaining(CHARGE, rows);
  assert.equal(net.amountCents, 336000n);
  assert.equal(net.taxAmountCents, 40320n);
});

test('transfers against a different charge do not affect this one', () => {
  const rows = [
    CHARGE,
    { id: 'tx9', type: 'TRANSFER', reversalOf: 'somethingElse', amountCents: -100000n },
  ];
  assert.equal(netRemaining(CHARGE, rows).amountCents, 560000n);
});

test('a fully split charge has nothing remaining', () => {
  const rows = [
    CHARGE,
    { id: 'tx2', type: 'TRANSFER', reversalOf: 'tx1', amountCents: -560000n, taxAmountCents: -67200n },
  ];
  assert.equal(netRemaining(CHARGE, rows).amountCents, 0n);
});

// ── planSplit ───────────────────────────────────────────────────────────────

const MINIBAR = {
  id: 'tx3',
  folioId: 'A',
  type: 'CHARGE',
  chargeCode: 'MB',
  description: 'Minibar',
  amountCents: 15000n,
  taxAmountCents: 1800n,
  quantity: 1,
};

const OPTS = {
  sourceFolioId: 'A',
  targets: [
    { folioId: 'A', share: 60 },
    { folioId: 'B', share: 40 },
  ],
  folioNumbers: { A: 'F-1', B: 'F-2' },
  payerNames: { A: 'Arym Vendiola', B: 'Bartolome Vendiola' },
};

test('a split moves each target its share and leaves the source with the rest', () => {
  const rows = planSplit({ transactions: [MINIBAR], ...OPTS });
  // One pair: 40% of 15000 = 6000 moves to B, nothing "moves" to A.
  assert.equal(rows.length, 2);
  const out = rows.find((r) => r.folioId === 'A');
  const into = rows.find((r) => r.folioId === 'B');
  assert.equal(out.amountCents, -6000n);
  assert.equal(into.amountCents, 6000n);
});

test('no rows are written for the source folio keeping its own share', () => {
  // The source keeps its share by NOT moving it. A self-transfer would be a
  // zero-value pair on the same folio: noise on a printed document.
  const rows = planSplit({ transactions: [MINIBAR], ...OPTS });
  assert.equal(rows.filter((r) => r.reversalOf === 'tx3' && r.amountCents === 0n).length, 0);
  assert.ok(rows.every((r) => !(r.folioId === 'A' && r.amountCents > 0n)));
});

test('every pair nets to zero, so a split neither invents nor destroys money', () => {
  const rows = planSplit({
    transactions: [CHARGE, MINIBAR],
    ...OPTS,
    targets: [
      { folioId: 'A', share: 1 },
      { folioId: 'B', share: 1 },
      { folioId: 'C', share: 1 },
    ],
    folioNumbers: { A: 'F-1', B: 'F-2', C: 'F-3' },
    payerNames: { A: 'One', B: 'Two', C: 'Three' },
  });
  assert.equal(
    rows.reduce((a, r) => a + r.amountCents, 0n),
    0n
  );
  assert.equal(
    rows.reduce((a, r) => a + r.taxAmountCents, 0n),
    0n
  );
});

test('what each folio ends up holding matches the requested shares', () => {
  const rows = planSplit({ transactions: [CHARGE, MINIBAR], ...OPTS });
  const moved = (folioId) => rows.filter((r) => r.folioId === folioId).reduce((a, r) => a + r.amountCents, 0n);
  // B receives 40% of both lines: 224000 + 6000.
  assert.equal(moved('B'), 230000n);
  // A's face value is 575000; it gives away exactly what B received.
  assert.equal(moved('A'), -230000n);
});

test('payments, refunds and existing transfers are never split', () => {
  const rows = planSplit({
    transactions: [
      { id: 'p1', type: 'PAYMENT', amountCents: 500000n, description: 'Cash' },
      { id: 'r1', type: 'REFUND', amountCents: 10000n, description: 'Refund' },
      { id: 't1', type: 'TRANSFER', amountCents: 20000n, description: 'Moved', reversalOf: 'x' },
    ],
    ...OPTS,
  });
  assert.equal(rows.length, 0, 'none of these may be reassigned to another payer');
});

test('a line already fully split produces no further rows', () => {
  const rows = planSplit({
    transactions: [
      MINIBAR,
      { id: 't2', type: 'TRANSFER', reversalOf: 'tx3', amountCents: -15000n, taxAmountCents: -1800n },
    ],
    ...OPTS,
  });
  assert.equal(rows.length, 0);
});

test('a share rounding to zero cents on a line writes no row for that line', () => {
  // 1 cent split 99/1: the second payer's share rounds away. A zero-value pair
  // would be two meaningless lines on two printed folios.
  const oneCent = { ...MINIBAR, amountCents: 1n, taxAmountCents: 0n };
  const rows = planSplit({
    transactions: [oneCent],
    ...OPTS,
    targets: [
      { folioId: 'A', share: 99 },
      { folioId: 'B', share: 1 },
    ],
  });
  assert.equal(rows.length, 0);
});

test('both halves are TRANSFER rows carrying the original charge code', () => {
  const rows = planSplit({ transactions: [MINIBAR], ...OPTS });
  for (const r of rows) {
    assert.equal(r.type, 'TRANSFER');
    assert.equal(r.chargeCode, 'MB', 'a split minibar charge is still F&B revenue');
    assert.equal(r.reversalOf, 'tx3');
  }
});

test('the counterpart payer is named on the line, not just the folio number', () => {
  // A line reading "transferred to folio F-2" makes the reader look up who F-2
  // is. The point of naming payers is that the document does not need decoding.
  const rows = planSplit({ transactions: [MINIBAR], ...OPTS });
  const out = rows.find((r) => r.folioId === 'A');
  const into = rows.find((r) => r.folioId === 'B');
  assert.match(out.description, /F-2/);
  assert.match(out.description, /Bartolome Vendiola/);
  assert.match(into.description, /F-1/);
  assert.match(into.description, /Arym Vendiola/);
});

test('tax is split by the same shares as the charge it belongs to', () => {
  const rows = planSplit({ transactions: [MINIBAR], ...OPTS });
  const into = rows.find((r) => r.folioId === 'B');
  assert.equal(into.taxAmountCents, 720n); // 40% of 1800
  assert.equal(rows.find((r) => r.folioId === 'A').taxAmountCents, -720n);
});

test("each row's tax breakdown components sum to that row's tax", () => {
  // Without this the printed folio's tax section disagrees with its own balance,
  // and taxByComponent papers over the gap by dumping it on VAT.
  const taxed = {
    ...MINIBAR,
    taxAmountCents: 1800n,
    taxBreakdown: [
      { key: 'vat', label: 'VAT', rate: 0.12, amountCents: '1500' },
      { key: 'service', label: 'Service Charge', rate: 0.024, amountCents: '300' },
    ],
  };
  const rows = planSplit({ transactions: [taxed], ...OPTS });
  for (const r of rows) {
    const sum = r.taxBreakdown.reduce((a, b) => a + BigInt(b.amountCents), 0n);
    assert.equal(sum, r.taxAmountCents, 'components must account for the whole tax');
  }
});

test('breakdown amounts are decimal strings, because JSON cannot carry BigInt', () => {
  const taxed = {
    ...MINIBAR,
    taxBreakdown: [{ key: 'vat', label: 'VAT', rate: 0.12, amountCents: '1800' }],
  };
  const rows = planSplit({ transactions: [taxed], ...OPTS });
  for (const r of rows) {
    for (const b of r.taxBreakdown) {
      assert.equal(typeof b.amountCents, 'string');
      assert.match(b.amountCents, /^-?\d+$/);
    }
  }
});

test('the source half carries the negated breakdown, the destination the positive', () => {
  // planTransfer leaves taxBreakdown null, and the print model's fallback cannot
  // see the originating charge from a receiving folio — so the receiving folio
  // printed the whole transferred tax as VAT. These rows carry their own.
  const taxed = {
    ...MINIBAR,
    taxBreakdown: [{ key: 'service', label: 'Service Charge', rate: 0.024, amountCents: '1800' }],
  };
  const rows = planSplit({ transactions: [taxed], ...OPTS });
  const out = rows.find((r) => r.folioId === 'A');
  const into = rows.find((r) => r.folioId === 'B');
  assert.equal(out.taxBreakdown[0].amountCents, '-720');
  assert.equal(into.taxBreakdown[0].amountCents, '720');
  assert.equal(into.taxBreakdown[0].key, 'service', 'the component must not become VAT');
});

test('a line with no breakdown produces rows with no breakdown', () => {
  const rows = planSplit({ transactions: [MINIBAR], ...OPTS });
  assert.equal(rows[0].taxBreakdown, null);
});

test('a split refuses to run without at least two payers', () => {
  assert.throws(
    () => planSplit({ transactions: [MINIBAR], ...OPTS, targets: [{ folioId: 'A', share: 100 }] }),
    /at least two/i
  );
});

test('a split refuses targets that do not include the source folio', () => {
  // The source keeps a share by staying in the target list. Leaving it out would
  // silently move the whole bill off it.
  assert.throws(
    () =>
      planSplit({
        transactions: [MINIBAR],
        ...OPTS,
        targets: [
          { folioId: 'B', share: 50 },
          { folioId: 'C', share: 50 },
        ],
      }),
    /source folio/i
  );
});

// ── splitNote ───────────────────────────────────────────────────────────────

test('the note names the co-payers and their folios', () => {
  const note = splitNote({
    folioId: 'B',
    transactions: [
      { type: 'TRANSFER', reversalOf: 'tx1', amountCents: 224000n, folioId: 'B' },
      { type: 'TRANSFER', reversalOf: 'tx3', amountCents: 6000n, folioId: 'B' },
    ],
    counterparts: [{ folioId: 'A', folioNumber: 'F-1', payerName: 'Arym Vendiola' }],
  });
  assert.match(note, /split/i);
  assert.match(note, /Arym Vendiola/);
  assert.match(note, /F-1/);
});

test('a folio with no transfers has no split note at all', () => {
  // Remark prints blank today and must keep doing so on an unsplit folio.
  assert.equal(splitNote({ folioId: 'A', transactions: [], counterparts: [] }), '');
});

test('the note lists several co-payers once each, not once per moved line', () => {
  const note = splitNote({
    folioId: 'A',
    transactions: [
      { type: 'TRANSFER', reversalOf: 'tx1', amountCents: -1000n, folioId: 'A' },
      { type: 'TRANSFER', reversalOf: 'tx3', amountCents: -2000n, folioId: 'A' },
    ],
    counterparts: [
      { folioId: 'B', folioNumber: 'F-2', payerName: 'Bartolome Vendiola' },
      { folioId: 'C', folioNumber: 'F-3', payerName: 'Company Ltd' },
    ],
  });
  assert.equal(note.match(/Bartolome Vendiola/g).length, 1);
  assert.match(note, /Company Ltd/);
});

test('the two halves of a pair carry mirror-image breakdowns, component by component', () => {
  // Summing to the row's tax is not enough. A first cut allocated the POSITIVE
  // original components for both halves and then reconciled that positive sum
  // against the source half's NEGATIVE tax, dumping the difference on the
  // largest component: a 3-way split of 220.00 tax printed the source's share
  // as "vat=-10666 serviceCharge=+3333" — right total, invented composition,
  // and a positive service charge on a line that gives money away.
  const taxed = {
    ...MINIBAR,
    taxAmountCents: 22000n,
    taxBreakdown: [
      { key: 'vat', label: 'VAT', rate: 12, amountCents: '12000' },
      { key: 'serviceCharge', label: 'Service Charge', rate: 10, amountCents: '10000' },
    ],
  };
  const rows = planSplit({
    transactions: [taxed],
    ...OPTS,
    targets: [
      { folioId: 'A', share: 1 },
      { folioId: 'B', share: 1 },
      { folioId: 'C', share: 1 },
    ],
    folioNumbers: { A: 'F-1', B: 'F-2', C: 'F-3' },
    payerNames: { A: 'One', B: 'Two', C: 'Three' },
  });

  // Pairs come out in order: [outA->B, intoB, outA->C, intoC].
  for (let i = 0; i < rows.length; i += 2) {
    const out = rows[i];
    const into = rows[i + 1];
    assert.equal(out.taxBreakdown.length, into.taxBreakdown.length);
    for (let k = 0; k < out.taxBreakdown.length; k++) {
      assert.equal(out.taxBreakdown[k].key, into.taxBreakdown[k].key);
      assert.equal(
        BigInt(out.taxBreakdown[k].amountCents),
        -BigInt(into.taxBreakdown[k].amountCents),
        `component ${out.taxBreakdown[k].key} must be the exact negation on the source half`
      );
    }
    // And every component still keeps the sign of the half it sits on.
    assert.ok(into.taxBreakdown.every((c) => BigInt(c.amountCents) >= 0n), 'incoming tax is positive');
    assert.ok(out.taxBreakdown.every((c) => BigInt(c.amountCents) <= 0n), 'outgoing tax is negative');
  }
});
