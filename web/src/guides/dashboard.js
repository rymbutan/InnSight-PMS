// Home dashboard guides. '/' renders a DIFFERENT dashboard per role (see the role
// routing at the top of pages/Dashboard.jsx), so this file exports one guide per
// dashboard. guideForPath takes the first guide whose `roles` match and `roles`
// can only say "has any of these", so the order below reproduces the routing:
//
//   1. ADMIN                          -> front-office dashboard (always, even with other roles)
//   2. MANAGER (and not ADMIN)        -> manager dashboard
//   3. FRONT_DESK (not ADMIN/MANAGER) -> front-office dashboard
//   4. AUDITOR (not ADMIN/MANAGER/FRONT_DESK) -> auditor dashboard
//   5. HOUSEKEEPING_MAINTENANCE (and none of the above) -> housekeeping dashboard
//   6. anyone else                    -> front-office dashboard (no roles = fallback)

const outlookSteps = (p, who) => [
  {
    target: `[data-tour="g-dashboard-${p}-outlook"]`,
    title: '14 Day Outlook',
    body: `A forecast of the next two weeks. The big percentage is how full the hotel is across all 14 days, and the small line beside it shows how that changes day by day, from today to 14 days ahead.`,
  },
  {
    target: `[data-tour="g-dashboard-${p}-legend"]`,
    title: 'Reading the heat map',
    body: `Each cell is one room type on one day, and the number is how many rooms of that type are still free to sell. The colour shows how much of that type is already sold, so a dark cell with a small number means nearly full. ${who}`,
  },
];

const frontOfficeSteps = [
  {
    target: '[data-tour="g-dashboard-fo-head"]',
    title: 'Your home screen',
    body: "This is the front-office dashboard: today's date, the live status and everything the desk needs to start the shift. The green Live badge means the page refreshes itself whenever a booking, check-in or room changes, and the refresh button reloads it on demand.",
  },
  {
    target: '[data-tour="g-dashboard-fo-create"]',
    title: 'Create new reservation',
    body: 'The fastest way to start a booking. It opens the new-reservation form, where you pick dates, room type and guest. Only Admin, Manager and Front Desk accounts see this button.',
  },
  {
    target: '[data-tour="g-dashboard-fo-kpis"]',
    title: 'The headline numbers',
    body: 'A row of tiles that answers "how is today going?" The first three are live counts for today. The ones after them come from the last closed night audit, so they describe yesterday-style results rather than the current moment.',
  },
  {
    target: '[data-tour="g-dashboard-fo-arrivals"]',
    title: 'Arrivals and Departures',
    body: 'Arrivals is the number of guests due to check in today, and Departures is the number due to check out today. They are today only, so overdue no-shows from earlier days are not counted here; the Arrivals page shows the full worklist.',
  },
  {
    target: '[data-tour="g-dashboard-fo-booked"]',
    title: 'Booked (rooms in use)',
    body: 'The big number is how many guests are checked in right now, and the percentage next to it is that count divided by all rooms in the hotel. It changes the moment someone checks in or out.',
  },
  {
    target: '[data-tour="g-dashboard-fo-audit"]',
    title: 'Occupancy, ADR, RevPAR and Room revenue',
    body: 'These four tiles read the most recent closed business day. Occupancy is the share of rooms sold, ADR is the average rate per sold room, RevPAR is room revenue per available room, and Room revenue is the total. They only appear once a night audit has been run, and only for roles allowed to see audit figures.',
  },
  {
    target: '[data-tour="g-dashboard-fo-restabs"]',
    title: 'Reservations panel',
    body: 'Your daily worklist. Each tab filters the list: Arrivals, Departures, Stayovers (in-house guests staying past today), In-House Guests, and Pending Payment (confirmed bookings with no deposit yet).',
    try: 'Click a tab such as Departures to switch the list, then continue.',
  },
  {
    target: '[data-tour="g-dashboard-fo-reservations"]',
    title: 'Working the list',
    body: 'Use the Today and Tomorrow switch to look ahead, and type a name in Guest Name to narrow the list. Click a row, or the arrow-in icon at its end, to open that reservation and check the guest in. Managers and admins also get a trash icon to delete a booking.',
  },
  {
    target: '[data-tour="g-dashboard-fo-acttabs"]',
    title: "Today's Activity",
    body: 'Three views of the last 14 days. Sales counts bookings by the day they were made, Cancelations shows cancelled and no-show bookings with the room nights lost, and Sold out lists room types with nothing left to sell in the next 14 days. The bar chart shows the shape of the fortnight.',
    try: 'Click Cancelations or Sold out to see the numbers and chart change.',
  },
  ...outlookSteps('fo', 'Zero means sold out, so that is where you may need to turn business away.'),
  {
    title: 'Tips',
    body: 'Start each shift at the Reservations panel: clear Arrivals, then check Pending Payment for deposits to chase. Hover over any heat-map cell for its exact figures, and use the sidebar to jump to Arrivals, Calendar or Folios for more detail.',
  },
];

const managerSteps = [
  {
    target: '[data-tour="g-dashboard-mgr-head"]',
    title: "The manager's dashboard",
    body: "Same front-office basics as the desk, plus trend charts, booking sources and a recent activity feed built for managing the day. The Live badge shows the page updates itself when anything changes.",
  },
  {
    target: '[data-tour="g-dashboard-mgr-kpis"]',
    title: 'Today at a glance',
    body: 'The Create new reservation button above opens the booking form. In this row, Arrivals and Departures are the guests due in and out today. Booked is how many guests are checked in right now and what percentage of all rooms that is.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-audit"]',
    title: 'Last audit KPIs with change vs prior day',
    body: 'Occupancy, ADR, RevPAR and Room revenue come from the latest closed night audit. The green or red arrow underneath compares each with the audit day before it, so you can see at once whether the hotel is trending up or down.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-occtrend"]',
    title: 'Occupancy Trend',
    body: 'Daily occupancy for up to the last 14 closed audit days, drawn from 0 to 100 percent. The two numbers underneath are the first and latest readings. If it asks you to run more night audits, there is not enough history yet.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-revtrend"]',
    title: 'Revenue Trend',
    body: 'Room revenue per closed audit day over the same 14 days. Read it beside Occupancy Trend: if revenue moved but occupancy did not, the change came from rate, not from more guests.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-bookings"]',
    title: 'Bookings',
    body: 'How many reservations were made each of the last 14 days (cancelled and no-show bookings are left out), with the total in the corner. It measures when bookings were taken, not when guests arrive.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-source"]',
    title: 'Bookings by Source',
    body: 'A donut showing where active reservations come from, such as walk-in, phone or online channels. Use it to see which channels bring the business.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-rooms"]',
    title: 'Room Occupancy',
    body: 'Every room grouped by its current status, coloured the same as the housekeeping map. The centre shows the percentage of rooms occupied right now.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-feed"]',
    title: 'Recent Activity',
    body: 'The latest new bookings, cancellations and real check-ins, newest first, with how long ago each happened. It is built from what you can already see here, not the full system audit log.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-restabs"]',
    title: 'Reservations worklist',
    body: 'Tabs for Arrivals, Departures, Stayovers, In-House Guests and Pending Payment, with a Today or Tomorrow switch and a guest-name search. Click a row to open the reservation, and use the printer icon for a paper copy.',
    try: 'Click a tab such as In-House Guests to change the list.',
  },
  {
    target: '[data-tour="g-dashboard-mgr-acttabs"]',
    title: "Today's Activity",
    body: 'Switch between Sales, Cancelations and Sold out to see the last 14 days as a chart and a short list. Cancelations also shows the room nights lost, which is a quick way to spot a bad week.',
  },
  ...outlookSteps('mgr', 'Use it to plan staffing and pricing for the busy dates.'),
];

const auditorSteps = [
  {
    target: '[data-tour="g-dashboard-aud-head"]',
    title: 'The auditor dashboard',
    body: 'Built around what an auditor does: check the day\'s figures, see where money came from and clear folios for check-out. The subtitle tells you which business day was last closed by the night audit.',
  },
  {
    target: '[data-tour="g-dashboard-aud-summary"]',
    title: 'Day Summary',
    body: "The closed day's figures. Gross is room, facility and other revenue plus tax, VAT is the tax collected, and Net is Gross minus VAT. If it says to run a night audit, no day has been closed yet.",
  },
  {
    target: '[data-tour="g-dashboard-aud-summary"]',
    title: 'Occupancy, ADR and RevPAR',
    body: 'Occupancy is the share of rooms sold, ADR is average daily rate per sold room, and RevPAR is revenue per available room. Compare them to spot a day where the rate or the room count looks off before you certify it.',
  },
  {
    target: '[data-tour="g-dashboard-aud-channels"]',
    title: 'Booking Channels',
    body: 'A donut of active reservations by booking source, with the total shown above it. A sudden shift between channels is worth a question to the manager.',
  },
  {
    target: '[data-tour="g-dashboard-aud-addons"]',
    title: 'Add-on Revenue',
    body: 'Walk-in add-on sales (such as amenities) over the last 30 days, with the grand total on top and the biggest add-ons listed by code, number of sales and revenue.',
  },
  {
    target: '[data-tour="g-dashboard-aud-folios"]',
    title: 'Folios to review',
    body: "Guest bills opened in the chosen period, newest first, up to eight at a time. A green tick means the folio is already approved. Click a row, or the eye icon, to open the full folio.",
  },
  {
    target: '[data-tour="g-dashboard-aud-tabs"]',
    title: 'Today, Week or Month',
    body: 'Choose how far back to list folios by the date they were opened. This only changes the list, nothing is saved.',
    try: 'Click Week or Month to widen the list.',
  },
  {
    target: '[data-tour="g-dashboard-aud-folios"]',
    title: 'Approving for check-out',
    body: 'An open folio that is not yet approved shows a tick-circle button. Pressing it signs the folio off so the front desk can check the guest out, so review the charges first. Only do this for real work, because it is recorded against your name.',
  },
  {
    title: 'Tips',
    body: 'The Live badge means figures refresh by themselves after a night audit or a folio sign-off. Use the sidebar for the Audit, Revenue and Reports pages when you need more than the daily snapshot.',
  },
];

const housekeepingSteps = [
  {
    target: '[data-tour="g-dashboard-hk-head"]',
    title: 'Your housekeeping dashboard',
    body: 'This page is your worklist: rooms to turn over, jobs assigned to you and calls from the front desk. The Live badge means it updates itself as rooms and calls change.',
  },
  {
    target: '[data-tour="g-dashboard-hk-status"]',
    title: 'Room status board',
    body: 'One tile per room status, each showing how many rooms are in that state right now (for example dirty, clean or inspected). Colours match the housekeeping map.',
  },
  {
    target: '[data-tour="g-dashboard-hk-status"]',
    title: 'Open the map',
    body: 'Click any status tile to jump to the housekeeping map, where you can see exactly which rooms those are and update them as you work.',
  },
  {
    target: '[data-tour="g-dashboard-hk-jobs"]',
    title: 'Job orders',
    body: 'The rooms a supervisor has assigned to you, with the room status, a priority and any request. Priority is Urgent for a spill (a slip hazard), Requested for other calls, and Routine when nothing is pending. The Open button takes you to the map.',
  },
  {
    target: '[data-tour="g-dashboard-hk-jobs"]',
    title: 'If the list is empty',
    body: 'Nothing is assigned to you yet. A supervisor assigns rooms on the housekeeping map, and unassigned rooms are still everyone\'s to pick up.',
  },
  {
    target: '[data-tour="g-dashboard-hk-history"]',
    title: 'Call history',
    body: 'Every call the front desk has placed to housekeeping, with a job number, room, time, reason, who asked and its status. A red Waiting pill shows how long a call has been unanswered. Pick up on a waiting call to take it.',
  },
  {
    target: '[data-tour="g-dashboard-hk-histtabs"]',
    title: 'Accepted, Declined, All',
    body: 'Filter the history by what happened to each call. A call that is still ringing only appears under All.',
    try: 'Click All or Accepted to change the list.',
  },
  ...outlookSteps('hk', 'Busy days ahead mean more rooms to turn over, so use it to plan your week.'),
  {
    title: 'Tips',
    body: 'Check the Waiting calls first, then your Urgent jobs, then routine rooms. When a room is finished, update its status on the housekeeping map so the front desk knows it is ready.',
  },
];

const frontOffice = {
  key: 'dashboard-front-office',
  title: 'Front-office dashboard tour',
  steps: frontOfficeSteps,
};

export default [
  { ...frontOffice, roles: ['ADMIN'] },
  { key: 'dashboard-manager', title: 'Manager dashboard tour', roles: ['MANAGER'], steps: managerSteps },
  { ...frontOffice, roles: ['FRONT_DESK'] },
  { key: 'dashboard-auditor', title: 'Auditor dashboard tour', roles: ['AUDITOR'], steps: auditorSteps },
  {
    key: 'dashboard-housekeeping',
    title: 'Housekeeping dashboard tour',
    roles: ['HOUSEKEEPING_MAINTENANCE'],
    steps: housekeepingSteps,
  },
  // No roles: matches everyone else, as the front-office dashboard does.
  frontOffice,
];
