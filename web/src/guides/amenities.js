// Guide for /amenities — see guides/index.js for the format.
export default {
  key: 'amenities',
  title: 'Amenities & Facilities',
  steps: [
    {
      title: 'What this page is for',
      body: 'Amenities are the hotel\'s sellable extras: function halls, meeting rooms, gym, pool, spa, parking, laundry and more. Here the desk books reservable spaces by time slot, and admins maintain the catalogue and its prices.',
    },
    {
      target: '[data-tour="g-amenities-overview"]',
      title: 'Overview chips',
      body: 'One chip per category, showing how many amenities it holds and how many of those are bookable. Click a chip to filter the catalogue by that category, and click it again to clear.',
    },
    {
      target: '[data-tour="g-amenities-bookings"]',
      title: 'Facility bookings for a day',
      body: 'Lists every booking on the chosen date: facility, time, guest, persons, charge and status. A charge marked "paid" has been posted to a folio. Front desk, managers and admins see this panel.',
    },
    {
      target: '[data-tour="g-amenities-date"]',
      title: 'Pick the date',
      body: 'Change this to see another day\'s schedule. Check it before promising a slot, because two bookings cannot share the same space and time.',
    },
    {
      target: '[data-tour="g-amenities-bookings"]',
      title: 'Cancelling a booking',
      body: 'A confirmed booking has a Cancel button, which asks you to confirm. Cancelling frees the slot and cannot be undone; a cancelled booking stays on the list, greyed out.',
    },
    {
      target: '[data-tour="g-amenities-guesttype"]',
      title: 'Hotel guest or non-hotel',
      body: 'Hotel guest bills an in-house guest: the charge posts to their open folio and is settled at check-out. Non-hotel is for visitors: you take their name, phone and payment method, and they pay now on their own visitor folio.',
    },
    {
      target: '[data-tour="g-amenities-book"]',
      title: 'Book a facility',
      body: 'Choose the facility (only reservable, active spaces appear), the guest, date, From and To times, and persons (limited by capacity). The Total preview uses the pricing model, such as per hour or per person; the server computes the real price.',
    },
    {
      target: '[data-tour="g-amenities-book"]',
      title: 'Confirm the booking',
      body: 'The button reads "Book & post to folio" for hotel guests or "Book & charge" for visitors. The end time must be after the start. If a hotel guest has no open folio, the slot is held but you must post the charge manually.',
    },
    {
      target: '[data-tour="g-amenities-catalog-toggle"]',
      title: 'The catalogue',
      body: 'The full catalogue, laundry, add-ons and promo codes are tucked away because they are reference, not the day\'s work. Open it when you need to check or change a price.',
      try: 'Click this bar to open the catalogue (you can hide it again with the arrow at the top).',
    },
    {
      target: '[data-tour="g-amenities-tabs"]',
      title: 'Catalog, Laundry, Add-ons, Promo Codes',
      body: 'Catalog lists every amenity with its pricing model, price and whether it is bookable. Laundry rings up a ticket of garments as one charge, Add-ons holds the priced extras for reservations (extra pillows, airport transfer), and Promo Codes sets percentage discounts. Tabs shown depend on your role.',
    },
    {
      title: 'Admin tools, tips and common mistakes',
      body: 'Admins can add items with the + button and use Save Price or Deactivate on each row; deactivating hides an item from selling and booking but keeps old bookings. If a space is not in the booking list, it is not marked Reservable or is inactive.',
    },
  ],
};
