// Guide for /folios/:id (an open folio) — see guides/index.js for the format.
export default {
  key: 'folio-detail',
  title: 'Working with a folio',
  steps: [
    {
      title: 'The open folio',
      body: 'This is one guest\'s bill for a stay. Everything that changes the money lives here: posting charges, taking payments and deposits, splitting the bill and, finally, closing the folio.',
    },
    {
      target: '[data-tour="g-folio-summary"]',
      title: 'Summary header',
      body: 'Shows who the folio bills, its number and status (Open or Closed) and how many guests are in the room. On a split bill it names that folio\'s payer, who may not be the person in the room.',
    },
    {
      target: '[data-tour="g-folio-actions"]',
      title: 'Folio actions',
      body: 'Print PDF gives a printable statement and Send to colleague shares this folio in chat. On an open folio you can also Split bill or Add folio, and Close folio once the balance is zero. Auditors and admins also see Approve for checkout.',
    },
    {
      target: '[data-tour="g-folio-audit"]',
      title: 'Audit approval gate',
      body: 'A guest cannot check out until an auditor signs the folio off, so the desk does not certify its own takings. If the bill changes after approval, the approval goes stale and the auditor must re-check it. This line is shown only while the folio is open.',
    },
    {
      target: '[data-tour="g-folio-metrics"]',
      title: 'Balance, charges and payments',
      body: 'Balance is what the guest still owes right now. Charges and Payments count how many of each are on the folio. Zero balance is required before the folio can be closed.',
    },
    {
      target: '[data-tour="g-folio-ledger"]',
      title: 'The ledger',
      body: 'Every line ever posted: date, type (Charge, Payment, Refund, Transfer), code, description, reference, amount and tax. A correction never deletes a line; it adds a reversal, so the history always adds up.',
    },
    {
      target: '[data-tour="g-folio-ledger"]',
      title: 'Dispute/Cancel and Move',
      body: 'Auditors, managers and admins see Dispute/Cancel on an open folio\'s lines; it needs a reason and nets the line to zero with a reversal. When a stay has several folios, Move shifts a charge onto another one. Payments stay where they were taken.',
    },
    {
      target: '[data-tour="g-folio-tabs"]',
      title: 'Charge, Payment and Deposit',
      body: 'The side panel has three forms, one at a time. Charge adds something the guest owes, Payment reduces the balance, and Deposit records money taken in advance.',
      try: 'Click the Payment tab to switch forms (you can switch back to Charge afterwards).',
    },
    {
      target: '[data-tour="g-folio-paymentform"]',
      title: 'Taking a payment',
      body: 'Pick a method and an amount. Card needs brand, last 4 digits and cardholder name; bank transfer needs the sender, a bank reference and the transfer time, with an optional proof upload. E-wallets can use Charge by QR, and card or bank payments may add a processing fee shown under the amount.',
    },
    {
      target: '[data-tour="g-folio-payments"]',
      title: 'Payments received and refunds',
      body: 'Once payments exist they are listed with method, status and reference. Each has Receipt and Email buttons; cash, card and bank payments can be refunded directly by finance roles, while e-wallet payments go through a Dispute case that someone approves later.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Post charges with the correct charge code, because it drives tax and reports. Never "fix" a mistake by posting an opposite charge; use Dispute/Cancel with a reason. To check a guest out: settle the balance, get audit approval, then close the folio.',
    },
  ],
};
