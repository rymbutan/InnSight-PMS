export default {
  key: 'reports',
  title: 'Reports',
  steps: [
    {
      title: 'What Reports is for',
      body: 'Reports turns the hotel\'s records into tables you can read, check and download: occupancy, revenue, arrivals, room status and more. Managers and auditors use it for the daily and monthly numbers. The Reports, Revenue and Night Audit pages share the switcher at the top.',
    },
    {
      target: '[data-tour="g-reports-picker"]',
      title: 'Choose, set dates, then Run',
      body: 'Every report is built the same way: pick the report, fill in the dates it asks for, then press Run. Nothing is calculated until you press Run, so changing a field alone does not refresh the results.',
    },
    {
      target: '[data-tour="g-reports-type"]',
      title: 'The report list',
      body: 'Occupancy, Revenue and Amenity revenue use a From and To date range. Arrivals and Departures use one single date. In-House Guests and Room status are live snapshots of right now and need no dates.',
      try: 'open the Report dropdown to see the seven reports, then pick one (or press Esc).',
    },
    {
      target: '[data-tour="g-reports-run"]',
      title: 'Run',
      body: 'Run asks the system for the report and replaces the lower half of the page with the answer. If a date field is left empty the system falls back to its own default range, so set dates when you want an exact period.',
    },
    {
      target: '[data-tour="g-reports-glance"]',
      title: 'At a glance (before you run anything)',
      body: 'Until you run a report, the page shows live room tiles: total rooms, in-house guests, vacant and ready, vacant and dirty, and rooms needing attention (out of service or out of order). These need no night audit, so they work even on a brand-new property.',
    },
    {
      target: '[data-tour="g-reports-recent"]',
      title: 'Recent report activity',
      body: 'This log lists the last 10 reports run, who ran them, when, and whether they completed. It is handy for seeing whether a colleague already pulled the figures you need.',
    },
    {
      target: '[data-tour="g-reports-results"]',
      title: 'Reading the results',
      body: 'Date-range reports show summary tiles first (for example average occupancy, ADR and RevPAR), a small chart when there are two or more days, and then a day-by-day table. Occupancy and Revenue figures come from closed night audits, so a day with no audit has no row.',
    },
    {
      target: '[data-tour="g-reports-export"]',
      title: 'Export CSV',
      body: 'After a report returns rows, Export CSV appears above the table. It downloads exactly the table you see as a spreadsheet-ready file you can open in Excel. The button is hidden when there are no rows.',
    },
    {
      title: 'Tips and common mistakes',
      body: '"No data" almost always means the dates are wrong or the night audit has not been run for those days. Remember that Arrivals and Departures take one date, not a range. Switching the report type clears nothing until you press Run again.',
    },
  ],
};
