export default {
  key: 'reservations',
  title: 'Reservations list',
  steps: [
    {
      title: 'The reservations list',
      body: 'This is every booking in the hotel, whether it is still a future hold, in-house now, or finished. Front desk and managers use it to find a booking, check its status and open it.',
    },
    {
      target: '[data-tour="g-reservations-head"] .filter-trigger',
      title: 'Open the filters',
      body: 'The Filter control sits beside the page title. It reveals date, status, room type and source filters so you can narrow a long list down.',
      try: 'Click Filter to open the filter panel.',
    },
    {
      target: '.filter-panel',
      title: 'What you can filter by',
      body: 'Check-in and check-out date ranges, Status, Room Types and Reservation Source (Direct, Walk-in, Booking.com, Airbnb, Expedia, Agoda, Other OTA). By default Cancelled bookings are hidden; tick Cancelled under Status to see them. Press APPLY to close the panel, or CLEAR to reset everything.',
    },
    {
      target: '[data-tour="g-reservations-search"]',
      title: 'Search by guest or confirmation number',
      body: 'Type a guest name or confirmation number. Suggestions appear as you type and picking one jumps straight to that reservation; if you keep typing without picking, the table below simply filters to matches.',
    },
    {
      target: '[data-tour="g-reservations-table"]',
      title: 'Reading the table',
      body: 'Each row shows the confirmation number, guest, headcount, date booked, room (or room type if none is assigned yet), dates, nights, total price, a status badge and the booking source. Click a column heading to sort by it; click again to reverse. Click any row to open the full reservation.',
    },
    {
      title: 'What the statuses mean',
      body: 'Pending is held but not yet confirmed. Confirmed is guaranteed and waiting to arrive. In-house or Checked-in means the guest is staying now. Checked-out is a finished stay. Cancelled and No-show are bookings that will not happen (a no-show is a guest who never arrived).',
    },
    {
      target: '[data-tour="g-reservations-paging"]',
      title: 'Counts and paging',
      body: 'This line shows which rows you are looking at out of the total that match your filters. Choose 20, 50, 100 or 200 rows per page and use the arrows to move between pages.',
    },
    {
      target: '[data-tour="g-reservations-export"]',
      title: 'Export and print',
      body: 'The download icon saves a CSV of every reservation matching your current filters (not just the visible page). The printer icon prints the page.',
    },
    {
      target: '.page-head .btn-cta',
      title: 'Creating a booking',
      body: 'Admins and front desk see Create new reservation, which opens the booking wizard. Managers and auditors do not see it: they review, correct and cancel existing bookings but do not create them.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'If a booking seems to be missing, check the Status filter first, since Cancelled is hidden by default, and then the date ranges. The list refreshes on its own when someone else changes a reservation, so you do not need to reload.',
    },
  ],
};
