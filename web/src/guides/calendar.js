export default {
  key: 'calendar',
  title: 'Calendar',
  steps: [
    {
      title: 'The booking calendar',
      body: 'The calendar shows rooms down the side and a 14-day window of nights across the top, so you can see at a glance who is in which room and which nights are free. It is open to admins, managers and front desk.',
    },
    {
      target: '[data-tour="g-calendar-views"]',
      title: 'Hotel Reservations or Facility Bookings',
      body: 'Switch between the rooms board and the Facility Bookings board for amenities. The facilities view is only available to admins, managers and front desk, and your chosen date window carries over when you switch.',
    },
    {
      target: '[data-tour="g-calendar-controls"]',
      title: 'Moving through time',
      body: 'Prev week and Next week shift the window by seven days, and Today jumps back to the current date. The month and date range are shown above the grid.',
    },
    {
      target: '[data-tour="g-calendar-board"]',
      title: 'Reading the grid',
      body: 'Each room row has a cell per night. Room types have a summary row showing how many rooms are free each night and the base rate; click the arrow to collapse a type. The percentage under each date is hotel occupancy that day. The dot beside a room number is its housekeeping status.',
    },
    {
      target: '.cal2-legend',
      title: 'Colours and stripes',
      body: 'Each guest gets their own colour so you can follow them across rooms and days. The stripe on the left edge of a bar is the status: Confirmed, In-house, Pending, Checked out, or Cancelled/no-show. A small dot means a balance is still owing.',
    },
    {
      target: '[data-tour="g-calendar-board"]',
      title: 'Drag to change a booking',
      body: 'Drag a bar sideways to move its dates, or up and down to change room. Drag its right edge to extend or shorten the stay. The change saves straight away, and is undone with an error message if the dates or room are not available.',
    },
    {
      target: '[data-tour="g-calendar-board"]',
      title: 'Click a cell',
      body: 'Clicking a night opens a small menu. New reservation here opens the booking wizard with that room, room type and date already filled in. On an occupied night it also offers View booking with the guest name, to open the reservation.',
    },
    {
      target: '[data-tour="g-calendar-cta"]',
      title: 'Create from the header',
      body: 'This button follows the board you are on: Create New Reservation for rooms, or Book a Facility for amenities.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'A notice such as "2 without a room" means bookings in this window have no room yet, so they cannot be drawn as bars. Assign a room from the reservation. On a phone the board is wide, so swipe sideways to scroll it.',
    },
  ],
};
