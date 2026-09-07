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

}

module.exports = { renderRegCard, CARD };
