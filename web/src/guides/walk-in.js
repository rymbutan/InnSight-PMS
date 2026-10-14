export default {
  key: 'walk-in',
  title: 'Walk-in check-in',
  steps: [
    {
      title: 'What a walk-in is',
      body: 'A walk-in is a guest who arrives without a booking. Unlike a normal reservation, this wizard checks them straight in to a room that is free right now and creates an in-house stay. Admins and front desk can use it.',
    },
    {
      target: '[data-tour="g-walk-in-steps"]',
      title: 'Four steps',
      body: 'Rooms, Details, Guests and Payment mirror the New Reservation wizard, so you collect the same information even though the guest did not call ahead.',
    },
    {
      target: '[data-tour="g-walk-in-intro"]',
      title: 'Step 1: Accommodation list',
      body: 'Only rooms that are clean (or clean and inspected) and not currently occupied are offered, grouped by room type with how many are free and the nightly rate. Press Select on a type to narrow the choices.',
    },
    {
      target: '[data-tour="g-walk-in-room"]',
      title: 'Assign a room and rate',
      body: 'Pick a specific room, or leave Auto-assign and the system picks the first available one. The nightly rate fills in from the room type, and you can overwrite it, for example to give a discount.',
    },
    {
      title: 'Step 2: Details',
      body: 'Enter the number of nights (check-out is calculated from today). You can also add special requests, company details and bank account details, which are saved to the guest profile.',
    },
    {
      title: 'Step 3: Guests',
      body: 'Set adults and children, then search for a returning guest or create a new one. Every new-guest field (name, email, phone, address) is required. Choosing an existing guest links the stay to their profile and lets you tick add-on preferences.',
    },
    {
      title: 'Step 4: Payment',
      body: 'A deposit is required before check-in. Half the grand total is suggested, and you choose the payment method. Card needs brand, last 4 digits and cardholder; bank transfer needs bank, network, sender, reference number and transfer time.',
    },
    {
      target: '[data-tour="g-walk-in-totals"]',
      title: 'Running totals',
      body: 'Subtotal, add-ons, taxes, grand total, suggested deposit and balance due update as you change the rate, nights and add-ons.',
    },
    {
      target: '[data-tour="g-walk-in-bar"]',
      title: 'Check-in walk-in',
      body: 'On the last step the button becomes Check-in walk-in. It creates the guest if new, checks them in, posts the deposit to the folio right away and takes you to Arrivals. Cancel returns to Arrivals and asks before discarding your entries.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'If no rooms are listed, none are clean and vacant right now. Ask housekeeping to finish cleaning, then reopen the page. Remember that the deposit and every guest field are mandatory, and check the rate before you continue.',
    },
  ],
};
