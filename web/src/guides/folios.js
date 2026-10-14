// Guide for /folios (the folio list and search) — see guides/index.js for the format.
export default {
  key: 'folios',
  title: 'Folios',
  steps: [
    {
      title: 'What a folio is',
      body: 'A folio is a guest\'s running bill for a stay. Charges (room, food, extras) add to it, payments reduce it, and the balance is what is still owed. Folios open automatically when a guest checks in, so you never create one from scratch here.',
    },
    {
      target: '[data-tour="g-folios-search"]',
      title: 'Find a folio',
      body: 'Type a folio number or a guest name and the list narrows after a short pause. Press Enter to commit: one match opens straight away. Escape or "Show all" brings back the recent folios.',
    },
    {
      target: '[data-tour="g-folios-list"]',
      title: 'Reading the list',
      body: 'Each row shows the folio number, the guest, the type of charge, the status and the balance. "Solo Charge" means one payer for the stay; "Split" means the bill was divided between several payers, each with their own folio.',
    },
    {
      target: '[data-tour="g-folios-list"]',
      title: 'Statuses and balance',
      body: 'Open folios can still take charges and payments. Closed folios are finished and read-only. A balance above zero means the guest still owes money; the folio must reach zero before it can be closed.',
    },
    {
      target: '[data-tour="g-folios-list"]',
      title: 'Open a folio',
      body: 'Click any row (or press Enter on it) to open that folio. The list then disappears and the folio\'s summary, ledger and action forms appear below the search bar. A second guide explains that screen.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'If a guest has a split bill, search by their name and check you opened the right payer\'s folio. Folios are visible to Admin, Manager, Front Desk and Auditor roles. If a folio you expect is missing, the guest has probably not been checked in yet.',
    },
  ],
};
