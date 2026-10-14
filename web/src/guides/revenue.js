export default {
  key: 'revenue',
  title: 'Revenue',
  steps: [
    {
      title: 'What Revenue is for',
      body: 'This is the revenue-management view: how well the rooms are selling and where bookings come from. It is built from closed night audits (the last 30 days) and the current reservation list, and it looks forward 14 days with a simple forecast.',
    },
    {
      target: '[data-tour="g-revenue-kpis"]',
      title: 'The four headline numbers',
      body: 'Average occupancy is the share of rooms sold. ADR (average daily rate) is room revenue divided by rooms sold. RevPAR is room revenue divided by ALL rooms available, so it rewards both price and filling the hotel. Room revenue is the 30-day total.',
    },
    {
      target: '[data-tour="g-revenue-forecast"]',
      title: 'Occupancy trend and 14-day forecast',
      body: 'The line shows the last 30 audited days followed by 14 forecast days, using a straight-line (linear regression) fit. Under it you see R-squared, which says how well the line fits (closer to 1.0 is more reliable), plus tomorrow\'s and +14 days\' forecast. It needs at least 2 audited days.',
    },
    {
      target: '[data-tour="g-revenue-source"]',
      title: 'Booking source mix',
      body: 'The donut counts current reservations by source: Direct, Walk-in, and online travel agencies such as Booking.com, Airbnb, Expedia or Agoda. A heavy OTA share usually means you are paying commission, so many hotels try to grow Direct.',
    },
    {
      target: '[data-tour="g-revenue-adr"]',
      title: 'ADR per day',
      body: 'Bars for the last 14 audited days. A drop means rooms sold cheaper (discounts, a cheaper room mix); a rise means higher rates. Hover a bar to see the exact peso value.',
    },
    {
      target: '[data-tour="g-revenue-revpar"]',
      title: 'RevPAR per day',
      body: 'The same 14 days, but measured against every room in the hotel. Compare it with ADR: if ADR is steady but RevPAR falls, the hotel emptied out rather than cut prices.',
    },
    {
      target: '[data-tour="g-revenue-los"]',
      title: 'Length of stay',
      body: 'Reservations grouped by number of nights: 1, 2-3, 4-7 and 8 or more. Lots of one-night stays mean more check-ins, housekeeping work and turnover for the same revenue.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Empty charts do not mean something is broken: they appear until at least two night audits have been closed. The forecast is a teaching model, not a guarantee, so look at R-squared before trusting it. Nothing on this page can be edited.',
    },
  ],
};
