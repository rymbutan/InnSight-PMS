// Guide for /arrivals — see guides/index.js for the format.
export default {
  key: 'arrivals',
  title: 'Arrivals & Departures',
  steps: [
    {
      title: 'The front desk worklist',
      body: 'This page is the desk\'s daily worklist: who is due to arrive, who is in the hotel now, and who leaves today. Check-in and check-out both happen here, and the lists refresh by themselves when something changes.',
    },
    {
      target: '[data-tour="g-arrivals-range"]',
      title: 'Choose the arrival window',
      body: 'Today shows guests due today, Week the next 7 days and Month the next 30. Use Week or Month to prepare ahead, for example to see which rooms will be needed.',
      try: 'Click Week to widen the list (you can click Today again afterwards).',
    },
    {
      target: '[data-tour="g-arrivals-table"]',
      title: 'Expected arrivals',
      body: 'Each row is a confirmed reservation: confirmation number, guest, expected date, nights and pax (adults plus children). Check-in starts the stay. Admins and managers also see Delete, which removes the reservation for good.',
    },
    {
      target: '[data-tour="g-arrivals-table"]',
      title: 'Overdue and early arrivals',
      body: 'A booking due before today that never arrived is marked Overdue and then Auto-cancelled, so it has no Check-in button; make a new booking or take the guest as a walk-in. Checking in someone due on a later date asks you to confirm an early check-in.',
    },
    {
      target: '[data-tour="g-arrivals-table"]',
      title: 'Checking a guest in',
      body: 'Check-in opens a window where you pick a room. Only clean and vacant rooms are listed, so if the list is empty, check Housekeeping. Confirm check-in creates the stay and opens the guest\'s folio.',
    },
    {
      target: '[data-tour="g-arrivals-inhouse"]',
      title: 'In-house guests',
      body: 'Everyone currently staying: stay ID, guest, room, check-in time and expected departure. Reg card downloads the registration card PDF, and Folio jumps to the guest\'s bill to post charges or take payment.',
    },
    {
      target: '[data-tour="g-arrivals-inhouse"]',
      title: 'Checking a guest out',
      body: 'Check-out asks you to confirm, then ends the stay. It will be refused unless the folio is settled and an auditor has approved it, so open the Folio first if it fails.',
    },
    {
      target: '[data-tour="g-arrivals-inhouse"]',
      title: 'Early departure',
      body: 'Early depart is for a guest leaving before the booked date. You enter the number of unused nights and the nightly rate, and a refund adjustment is posted to their folio. It is a red button because it moves money.',
    },
    {
      target: '[data-tour="g-arrivals-departures"]',
      title: 'Today\'s departures',
      body: 'A quick view of stays ending today with their room numbers. Use it to plan housekeeping and to chase guests who have not checked out; the actual check-out button is in the In-House list above.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Check the room is clean before promising it, and do not delete a reservation when you only mean to check in. Settle the folio before check-out, and use Early depart rather than editing the folio by hand.',
    },
  ],
};
