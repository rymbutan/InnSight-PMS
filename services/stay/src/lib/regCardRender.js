// Draws the registration card onto a pdfkit document.
//
// Split from the route for the same reason regCardModel is: the route's job is
// fetching (four upstreams, all allowed to fail), this file's job is geometry.
// Keeping them apart also means the card can be rendered outside an HTTP request
// — which is the only practical way to eyeball the layout.
//
// Absolute x/y throughout. pdfkit's cursor does not survive doc.image() or a
// doc.text() given an explicit width, and this card has been bitten by both: a
// QR once pushed the paragraph below it into a narrow strip down the right
// margin. Tracking `y` by hand is what keeps this stable as content grows.

const CARD = {
  margin: 48,
  width: 499, // A4 (595pt) less both 48pt margins
  rule: '#333',
  ink: '#000',
  soft: '#555',
};

// Terms & Conditions — page 2 of every registration card, unconditionally.
// PHP, not '₱': same reason as regCardModel's CURRENCY constant — pdfkit's
// built-in Helvetica is WinAnsi-encoded and has no glyph for U+20B1.
const TERMS_TITLE = 'Terms & Conditions';

const TERMS_SECTIONS = [
  {
    title: '1. Booking Confirmation & Guest Information',
    items: [
      {
        label: 'Mandatory Guest Data:',
        text: 'Guests must provide a valid Email Address and Mobile/Contact Number during booking. System confirmation dispatches automatically to both channels. Reservations will not be generated or held without complete contact details.',
      },
      {
        label: 'Identity Verification:',
        text: "Primary guests must present a valid government-issued photo ID (Passport, UMID, Driver's License, PhilID, SSS, or PRC) upon check-in. The registered guest name must match the ID presented.",
      },
      { label: 'Minimum Age:', text: 'The primary booking holder must be at least 18 years of age.' },
    ],
  },
  {
    title: '2. Standard Reservation Timelines & Incidental Deposits',
    items: [
      {
        label: 'Check-In / Check-Out:',
        text: 'Check-in begins at 2:00 PM; Check-out is at 12:00 NN. Late departures beyond 12:00 NN incur a 50% room rate charge, and departures after 4:00 PM are charged at 100% of the daily rate.',
      },
      {
        label: 'Incidental Security Deposit:',
        text: 'A refundable cash or credit authorization deposit of PHP 2,000 per room/night is collected upon check-in to cover incidental expenses or damage assessments.',
      },
    ],
  },
  {
    title: '3. Payment Methods, E-Wallets & Taxes',
    items: [
      {
        label: 'Payment Channels:',
        text: 'Transactions are settled via Credit/Debit Cards, Cash, or registered E-Wallet providers (GCash and Maya).',
      },
      {
        label: 'Currency & Customizable Tax:',
        text: 'All transactions are charged in Philippine Pesos (PHP). Quoted rates reflect local government tax levies, city charges, and 12% Value Added Tax (VAT), which are subject to administrative system configuration and updating.',
      },
      {
        label: 'Senior Citizen (RA 9994) & PWD (RA 10754) Discounts:',
        text: 'Valid OSCA or PWD cardholders receive statutory room and food discounts on individual stays. Per Philippine regulations, statutory discounts cannot be combined with promotional rates, discounted online packages, or group rates.',
      },
    ],
  },
  {
    title: '4. Cancellation, Refund Policies, and Administrative Deductions',
    items: [
      {
        label: 'Flexible Rate Tier (72-Hour Window):',
        text: '',
        subitems: [
          {
            label: 'Cancellations made more than 72 hours prior to standard check-in (2:00 PM):',
            text: 'Eligible for a 100% refund, minus a 3% merchant e-wallet/gateway processing fee or fixed PHP 200 administrative deduction.',
          },
          {
            label: 'Cancellations made between 24 and 72 hours prior to check-in:',
            text: 'Subject to a 50% cancellation fee deduction of the total booking cost.',
          },
          {
            label: 'Cancellations made less than 24 hours before check-in or No-Shows:',
            text: 'Subject to a 100% non-refundable deduction (entire deposit/payment forfeited).',
          },
        ],
      },
      {
        label: 'Promotional / Non-Refundable Tier:',
        text: 'Bookings flagged as "Non-Refundable" or "Promo Rate" are strictly ineligible for refunds upon booking confirmation.',
      },
      {
        label: 'Deductions for Damage & Rule Violations:',
        text: '',
        subitems: [
          {
            label: 'Smoking Penalty (EO 26):',
            text: 'Violations of the strict non-smoking policy incur an immediate PHP 5,000 deep-cleaning and sanitization charge deducted directly from the incidental deposit or billed separately.',
          },
          {
            label: 'Keycard / Asset Loss:',
            text: 'Unreturned or damaged keycards incur a deduction of PHP 500 per card. Property destruction or missing room amenities will be itemized and deducted at full replacement cost.',
          },
        ],
      },
    ],
  },
  {
    title: '5. E-Wallet (GCash & Maya) Refund Processing & Chargeback Logic',
    items: [
      {
        label: 'Refund Disbursement Window:',
        text: 'Approved GCash and Maya refunds are processed back exclusively to the original funding e-wallet account within 7 to 14 business days.',
      },
      {
        label: 'Third-Party Refund Prohibition:',
        text: 'Cash outs, checks, or transfers to alternative third-party bank accounts/e-wallets are strictly prohibited to prevent financial fraud.',
      },
      {
        label: 'Chargeback & Dispute Audits:',
        text: 'Initiating an unverified or fraudulent chargeback through GCash, Maya, or card networks triggers an automatic reservation revocation, guest blacklist flag, and immediate audit log entry in the PMS system ledger.',
      },
    ],
  },
  {
    title: '6. Force Majeure & Severe Weather Exceptions',
    items: [
      {
        label: 'Typhoon & Disaster Rebooking:',
        text: 'Penalties and cancellation fees are waived in the event of official Philippine Atmospheric, Geophysical and Astronomical Services Administration (PAGASA) Typhoon Signal No. 2 or higher, active natural disasters, or government travel mandates.',
      },
      {
        label: 'Resolution Options:',
        text: 'Guests affected by verified Force Majeure events receive a 100% Credit Shell valid for 12 months or a full cash/e-wallet refund (less non-recoverable third-party banking transaction fees).',
      },
    ],
  },
  {
    title: '7. Data Privacy Act Compliance (RA 10173)',
    items: [
      {
        label: '',
        text: 'All guest records (emails, contact numbers, payment records) are captured, stored, and encrypted strictly under the guidelines of the Philippine Data Privacy Act of 2012. Contact details are used strictly for reservation confirmation, operational alerts, and statutory reporting.',
      },
    ],
  },
  {
    title: '8. System Access Control & Platform Safeguards',
    items: [
      {
        label: 'Admin Privilege Controls:',
        text: 'Simulation timestamps and system-wide tax percentage modifications are strictly managed by Admin accounts. Admins are blocked from self-deactivating or self-disabling their accounts.',
      },
      {
        label: 'Manager Restrictions:',
        text: 'Manager accounts maintain read-only visibility over user lists, are prohibited from modifying Admin permissions, and have zero access to platform diagnostic/health metrics.',
      },
      {
        label: 'Reports Dashboard Default States:',
        text: 'Dynamic metric cards and operational summaries auto-populate the lower reports interface upon load; empty state components display automatically whenever live reporting data is absent.',
      },
    ],
  },
];

const TERMS_ACK_TEXT =
  "By checking this box, I acknowledge that I have read, understood, and agree to be bound by the hotel's Terms of Service and Privacy Policy.";

function cardRect(doc, x, y, w, h) {
  doc.lineWidth(0.7).strokeColor(CARD.rule).rect(x, y, w, h).stroke();
}

// A bordered label/value row. Returns the y below it.
function cardFieldRow(doc, y, label, value, { labelW = 104, h = 21 } = {}) {
  const { margin: m, width: w } = CARD;
  cardRect(doc, m, y, labelW, h);
  cardRect(doc, m + labelW, y, w - labelW, h);
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(CARD.ink)
    .text(label, m + 6, y + 6.5, { width: labelW - 12, lineBreak: false });
  if (value) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(CARD.ink)
      .text(String(value), m + labelW + 7, y + 6, {
        width: w - labelW - 14,
        lineBreak: false,
        ellipsis: true,
      });
  }
  return y + h;
}

// Section heading with a rule under it and NO fill — the reference form uses a
// solid colour band here; this property's card is monochrome by request.
function cardHeading(doc, x, y, w, text) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(CARD.ink).text(text, x, y, {
    width: w,
    lineBreak: false,
    characterSpacing: 0.4,
  });
  const ruleY = y + 12;
  doc.lineWidth(1).strokeColor(CARD.rule).moveTo(x, ruleY).lineTo(x + w, ruleY).stroke();
  return ruleY + 7;
}

function cardTick(doc, x, y, checked, label, { labelW = 70 } = {}) {
  const box = 8;
  doc.lineWidth(0.7).strokeColor(CARD.rule).rect(x, y, box, box).stroke();
  if (checked) {
    doc
      .save()
      .lineWidth(1.3)
      .strokeColor(CARD.ink)
      .moveTo(x + 1.5, y + 4.3)
      .lineTo(x + 3.3, y + 6.2)
      .lineTo(x + 6.6, y + 1.8)
      .stroke()
      .restore();
  }
  if (label) {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(CARD.ink)
      .text(label, x + box + 5, y + 0.5, { width: labelW, lineBreak: false });
  }
}

// Terms & Conditions page. Unlike the card above, this flows with pdfkit's own
// cursor (doc.x/doc.y) instead of hand-tracked coordinates: the text is long
// enough that it may legitimately spill past one page, and pdfkit only
// auto-inserts a page break for wrapped text when it owns the cursor. Every
// draw call below either omits y (continuing from doc.y) or reads doc.y back
// afterwards, so a mid-paragraph page break never leaves the next line using a
// stale position.
function termsEnsureRoom(doc, needed) {
  const { margin: m } = CARD;
  if (doc.y + needed > doc.page.height - m) doc.addPage();
}

function termsHeading(doc, x, width, text) {
  termsEnsureRoom(doc, 20);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(CARD.ink).text(text, x, doc.y, { width, lineBreak: false });
  const ruleY = doc.y + 2;
  doc.lineWidth(0.8).strokeColor(CARD.rule).moveTo(x, ruleY).lineTo(x + width, ruleY).stroke();
  doc.y = ruleY + 7;
}

// One bullet (or sub-bullet, via baseIndent) with an optional bold lead-in.
// The marker is drawn first, at the y captured before either it or the label
// advance the cursor, so the label/text pair — not the one-character marker —
// is what determines how far doc.y actually moves.
function termsBullet(doc, x, width, bullet, label, text, { baseIndent = 0, size = 8, gap = 5 } = {}) {
  termsEnsureRoom(doc, size * 1.6);
  const y = doc.y;
  const bulletX = x + baseIndent;
  const textIndent = baseIndent + 12;
  const textX = x + textIndent;
  const textW = width - textIndent;

  doc.font('Helvetica').fontSize(size).fillColor(CARD.ink).text(bullet, bulletX, y, { width: 10, lineBreak: false });

  if (label) {
    doc
      .font('Helvetica-Bold')
      .fontSize(size)
      .fillColor(CARD.ink)
      .text(`${label}${text ? ' ' : ''}`, textX, y, { width: textW, continued: Boolean(text) });
    if (text) doc.font('Helvetica').fontSize(size).fillColor(CARD.ink).text(text, { width: textW });
  } else {
    doc.font('Helvetica').fontSize(size).fillColor(CARD.ink).text(text, textX, y, { width: textW });
  }
  doc.y += gap;
}

function renderTermsPage(doc, model) {
  const { margin: m, width: W } = CARD;
  doc.addPage();
  doc.y = m;

  doc.font('Helvetica-Bold').fontSize(16).fillColor(CARD.ink).text(TERMS_TITLE, m, m, { width: W, lineBreak: false });
  const guestName = model?.fields?.find((f) => f.label === 'Name')?.value;
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(CARD.soft)
    .text(
      `${model?.title || 'Registration Card'}${model?.confirmationNumber ? `  ·  ${model.confirmationNumber}` : ''}${
        guestName ? `  ·  ${guestName}` : ''
      }`,
      m,
      doc.y + 2,
      { width: W, lineBreak: false }
    );
  doc.y += 20;

  for (const section of TERMS_SECTIONS) {
    termsHeading(doc, m, W, section.title);
    for (const item of section.items) {
      termsBullet(doc, m, W, '•', item.label, item.text);
      for (const sub of item.subitems || []) {
        termsBullet(doc, m, W, 'o', sub.label, sub.text, { baseIndent: 14 });
      }
    }
    doc.y += 5;
  }

  // Acknowledgment — an unchecked box, exactly as printed: the guest checks
  // and signs this in ink, the PDF only supplies the box to check.
  termsEnsureRoom(doc, 40);
  doc.y += 4;
  const ackY = doc.y;
  cardTick(doc, m, ackY, false, '', { labelW: 0 });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(CARD.ink)
    .text(TERMS_ACK_TEXT, m + 16, ackY - 1, { width: W - 16 });
  doc.y += 10;

  const sigY = doc.y + 22;
  const sigW = (W - 20) / 2;
  [
    ['Guest Signature', m],
    ['Date', m + sigW + 20],
  ].forEach(([label, x]) => {
    doc.lineWidth(0.7).strokeColor(CARD.rule).moveTo(x, sigY).lineTo(x + sigW, sigY).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(CARD.ink).text(label, x, sigY + 5, { width: sigW, lineBreak: false });
  });
}

/**
 * @param {PDFDocument} doc     an open pdfkit document (A4, 48pt margin)
 * @param {object}      model   from regCardModel()
 * @param {object}     [opts]
 * @param {Buffer}     [opts.qrPng]      pre-rendered QR, drawn in the header square
 * @param {string}     [opts.qrCaption]  caption under the QR
 */
function renderRegCard(doc, model, { qrPng = null, qrCaption = '' } = {}) {
    const { margin: m, width: W } = CARD;
    let y = m;

    // ── Title, with the QR in the square the reference form gives the logo ──
    const qrBox = 74;
    const qrX = m + W - qrBox;
    doc
      .font('Helvetica-Bold')
      .fontSize(19)
      .fillColor(CARD.ink)
      .text(model.title, m, y + 20, { width: W - qrBox - 20, lineBreak: false });
    if (model.confirmationNumber) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(CARD.soft)
        .text(`${model.confirmationNumber}${model.room ? `  ·  Room ${model.room}` : ''}`, m, y + 45, {
          width: W - qrBox - 20,
          lineBreak: false,
        });
    }

    // The QR arrives already rendered: resolving the portal link is a network
    // concern and belongs to the route, not to the layout. When it is absent the
    // square is simply left empty — a card without a QR is still a valid card,
    // and a QR that leads to "Not found" is worse than none.
    if (qrPng) {
      doc.image(qrPng, qrX, y, { width: qrBox, height: qrBox });
      if (qrCaption) {
        doc
          .font('Helvetica')
          .fontSize(6)
          .fillColor(CARD.soft)
          .text(qrCaption, qrX - 6, y + qrBox + 3, { width: qrBox + 12, align: 'center' });
      }
    }

    y = m + qrBox + 18;

    // ── Guest fields ──
    for (const f of model.fields) y = cardFieldRow(doc, y, `${f.label}:`, f.value);

    // ── Venue + duration, side by side ──
    y += 18;
    const colGap = 19;
    const colW = (W - colGap) / 2;
    const rightX = m + colW + colGap;

    let leftY = cardHeading(doc, m, y, colW, model.venue.heading);
    doc.font('Helvetica').fontSize(8.5).fillColor(CARD.ink);
    for (const line of model.venue.lines) {
      doc.text(line, m, leftY, { width: colW, lineBreak: false, ellipsis: true });
      leftY += 11.5;
    }
    if (!model.venue.lines.length) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(CARD.soft)
        .text('Set the property details in Settings → Hotel.', m, leftY, { width: colW });
      leftY += 11.5;
    }

    let rightY = cardHeading(doc, rightX, y, colW, model.duration.heading);
    let tickX = rightX;
    for (const opt of model.duration.options) {
      cardTick(doc, tickX, rightY, opt.checked, opt.label, { labelW: 52 });
      tickX += colW / 3;
    }
    rightY += 18;
    cardTick(doc, rightX, rightY, Boolean(model.duration.otherNights), '', { labelW: 0 });
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(CARD.ink)
      .text(
        model.duration.otherNights ? `${model.duration.otherNights} Nights` : '______ Nights',
        rightX + 14,
        rightY + 0.5,
        { width: colW - 14, lineBreak: false }
      );
    rightY += 16;

    y = Math.max(leftY, rightY) + 12;

    // ── Rate card ──
    const rateLabelW = W - 132;
    const rowH = 20;
    cardRect(doc, m, y, rateLabelW, rowH);
    cardRect(doc, m + rateLabelW, y, W - rateLabelW, rowH);
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(CARD.ink)
      .text(model.rooms.columns[0], m + 7, y + 6.5, { width: rateLabelW - 14, lineBreak: false })
      .text(model.rooms.columns[1], m + rateLabelW + 7, y + 6.5, {
        width: W - rateLabelW - 14,
        lineBreak: false,
      });
    y += rowH;
    for (const r of model.rooms.rows) {
      cardRect(doc, m, y, rateLabelW, rowH);
      cardRect(doc, m + rateLabelW, y, W - rateLabelW, rowH);
      cardTick(doc, m + 8, y + 6, r.checked, r.name, { labelW: rateLabelW - 30 });
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(CARD.ink)
        .text(r.rate, m + rateLabelW + 7, y + 6, { width: W - rateLabelW - 14, lineBreak: false });
      y += rowH;
    }
    if (!model.rooms.rows.length) {
      cardRect(doc, m, y, W, rowH);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(CARD.soft)
        .text('Rate card unavailable.', m + 7, y + 6.5, { width: W - 14, lineBreak: false });
      y += rowH;
    }

    // ── Policy note ──
    y += 14;
    doc.font('Helvetica').fontSize(8).fillColor(CARD.ink);
    for (const note of model.notes) {
      doc.text(note, m, y, { width: W, align: 'left' });
      y = doc.y + 6;
    }

    // ── Arrival / departure grid ──
    y += 8;
    const schedCols = [W - 300, 100, 100, 100];
    const drawSchedRow = (cells, bold) => {
      let x = m;
      cells.forEach((cell, i) => {
        cardRect(doc, x, y, schedCols[i], rowH);
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(bold ? 8 : 8.5)
          .fillColor(CARD.ink)
          .text(cell || '', x + 7, y + 6.5, { width: schedCols[i] - 14, lineBreak: false });
        x += schedCols[i];
      });
      y += rowH;
    };
    drawSchedRow(model.schedule.columns, true);
    for (const r of model.schedule.rows) drawSchedRow([r.label, r.date, r.time, r.flight], false);

    // ── Signature strip ──
    y += 30;
    const sigW = (W - 40) / 3;
    const sig = [
      ['Total cost', model.totals.totalCost],
      ['Date', ''],
      ['Signature', ''],
    ];
    sig.forEach(([label, value], i) => {
      const x = m + i * (sigW + 20);
      if (value) {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(CARD.ink)
          .text(value, x, y - 12, { width: sigW, lineBreak: false });
      }
      doc.lineWidth(0.7).strokeColor(CARD.rule).moveTo(x, y).lineTo(x + sigW, y).stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(CARD.ink)
        .text(label, x, y + 5, { width: sigW, lineBreak: false });
    });

    // ── Page 2: Terms & Conditions, permanently — every card gets one, not
    // just cards where the desk remembered to attach the handout. ──
    renderTermsPage(doc, model);
}

module.exports = { renderRegCard, CARD };
