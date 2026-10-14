export default {
  key: 'reservation-detail',
  title: 'Reservation detail',
  steps: [
    {
      title: 'One booking, everything in one place',
      body: 'This page is the full record of a single reservation: its status, dates, money, guest details, notes and history. You get here by clicking a row in Reservations, a bar in the Calendar, or a search result.',
    },
    {
      target: '[data-tour="g-reservation-detail-header"]',
      title: 'The header',
      body: 'It shows the guest name, the confirmation number and the current status badge. The Actions menu on the right changes what it offers depending on the status.',
    },
    {
      target: '[data-tour="g-reservation-detail-actions"]',
      title: 'The Actions menu',
      body: 'Pending bookings can be Confirmed. Confirmed or Pending ones can be Checked In or edited with Modify Dates / Quick Edit. In-house guests can be Checked Out, which settles the folio. Print Registration Card needs a stay, Send Confirmation Email is available once confirmed, and Send to Colleague shares the booking in chat.',
    },
    {
      target: '[data-tour="g-reservation-detail-actions"]',
      title: 'Risky actions',
      body: 'Mark No-Show (admin, manager, auditor) is for guests who never arrived and can post a fee. Cancel Reservation asks for a reason and a suggested cancellation fee. After a cancellation, admins, managers and auditors can Refund/Forfeit Deposit. Delete Record permanently erases a booking and is for admins and managers only.',
    },
    {
      target: '[data-tour="g-reservation-detail-summary"]',
      title: 'Booking summary',
      body: 'Check-in and check-out dates, nights, when it was booked, headcount, source, payment type and rate plan, all at a glance. Quick Edit can correct these fields.',
    },
    {
      target: '[data-tour="g-reservation-detail-balance"]',
      title: 'Balance Due',
      body: 'This is the estimated total minus the deposit received. It shows a warning colour while money is owed and a tick when settled.',
    },
    {
      target: '[data-tour="g-reservation-detail-more"]',
      title: 'Show more',
      body: 'Reveals origin and estimated arrival time. On a cancelled booking it also shows the cancellation number, fee, reason and what is left of the deposit to refund.',
    },
    {
      target: '[data-tour="g-reservation-detail-tabs"]',
      title: 'The tabs',
      body: 'Accommodations, Folio, Guest Details, Banking Details, Notes, Documents and Reservation Activity each hold a different part of the record. Notes shows a count of active notes.',
    },
    {
      target: '[data-tour="g-reservation-detail-tabs"] button:nth-child(2)',
      title: 'Folio tab',
      body: 'A folio is the guest bill: charges (debits) and payments (credits). It is created automatically at check-in, so before then this tab says there is no folio yet. Once it exists you can add payments, charges and adjustments here; refunds are limited to admins, managers and auditors.',
      try: 'Click the Folio tab to look at it.',
    },
    {
      target: '[data-tour="g-reservation-detail-tabs"]',
      title: 'The other tabs',
      body: 'Guest Details edits the name, email and phone (auditors can only read). Banking Details keeps a masked card guarantee on file, never a full card number. Notes holds staff notes you can archive. Documents stores uploads like IDs, up to 10 MB each. Reservation Activity is the timeline of everything that happened to the booking.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Use Cancel when a guest will not come, because Delete erases the record and cannot be undone. Remember that the folio and the deposit post only after check-in, so a missing folio before arrival is normal.',
    },
  ],
};
