export default {
  key: 'reservation-new',
  title: 'Creating a reservation',
  steps: [
    {
      title: 'New reservation wizard',
      body: 'Booking a future stay takes four steps: Availability, Details, Guests, Payment. Only admins and front desk can create reservations. Totals update as you go, and you can go back to any step before confirming.',
    },
    {
      target: '[data-tour="g-reservation-new-steps"]',
      title: 'Where you are',
      body: 'The numbered tracker shows the current step, with a tick on finished ones. The buttons at the bottom of the screen move you forward and back.',
    },
    {
      target: '[data-tour="g-reservation-new-search"]',
      title: 'Source, dates and promo code',
      body: 'Source records where the booking came from (Direct, an online travel agency and so on). Choose check-in and check-out dates; check-out must be after check-in. A promo code, if entered, is checked by the server and its discount applied to the total.',
    },
    {
      target: '[data-tour="g-reservation-new-nonrefund"]',
      title: 'Non-refundable / promo rate',
      body: 'Tick this for promotional bookings that forfeit the full amount if cancelled, regardless of timing. It is saved on the reservation and used later when a cancellation fee is suggested.',
    },
    {
      target: '[data-tour="g-reservation-new-rooms"]',
      title: 'Search and pick accommodations',
      body: 'Press Search to list room types with their max occupancy and rate per night, then Add the types you want. Each pick can be given a quantity and a specific room, which only offers rooms actually free for your dates. Leave it on Auto-assign to let the system choose.',
    },
    {
      title: 'Step 2: Details',
      body: 'Shows the dates, nights and a summary of your picks. Add free-text special requests (quick-pick buttons help), plus optional company details and bank account details. Standing guest preferences live on the guest profile rather than here.',
    },
    {
      title: 'Step 3: Guests',
      body: 'Enter adults and children, then search for an existing guest to avoid duplicates, or create a new one. A new guest needs first name, last name, email, phone and the full address before you can continue. For an existing guest you can also tick add-on preferences, which are charged to this booking and saved to their profile.',
    },
    {
      title: 'Step 4: Payment',
      body: 'A downpayment is mandatory. Enter the deposit amount (half of the grand total is suggested) and pick the payment method. Card needs brand, last 4 digits and cardholder name; bank transfer needs bank, network, sender, reference number and transfer time. Card and bank payments may add a processing fee.',
    },
    {
      target: '[data-tour="g-reservation-new-totals"]',
      title: 'Running totals',
      body: 'Subtotal is rooms times nights, then add-ons and taxes and fees give the Grand Total. Balance Due is what remains after the deposit. These stay on screen through every step.',
    },
    {
      target: '[data-tour="g-reservation-new-bar"]',
      title: 'Moving between steps and confirming',
      body: 'The next button is named after the next step; on the last step it becomes Confirm & Pay, which creates the guest if new, creates the reservation and confirms it automatically. The deposit posts to the folio after check-in. Cancel discards your work after a confirmation.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Dates and at least one room must be chosen before leaving step 1. Missing guest fields or a missing deposit are the most common blockers. If you arrive from a calendar cell, the dates and room are pre-filled, so check them before continuing.',
    },
  ],
};
