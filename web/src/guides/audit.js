export default {
  key: 'audit',
  title: 'Night Audit',
  steps: [
    {
      title: 'What the Night Audit is',
      body: 'The night audit is the end-of-day routine that closes the hotel\'s business day. It charges every in-house guest for the night, cleans up bookings that never arrived, records the day\'s statistics, and locks the day. Only Admins, Managers and Auditors can open this page.',
    },
    {
      target: '[data-tour="g-audit-current-day"]',
      title: 'The current business day',
      body: 'This shows the open day\'s date and status. If no day is open you will see "No open business day" and an Open today button instead. Opening a day only creates today\'s record, so it is safe, but a date can only ever be opened once.',
    },
    {
      target: '[data-tour="g-audit-metrics"]',
      title: 'Live figures for the day',
      body: 'In-house stays is the number of guests currently checked in, which is how many room charges the audit will post. Room, facility and other revenue are the day\'s totals so far, and Total revenue adds them up.',
    },
    {
      target: '[data-tour="g-audit-explain"]',
      title: 'What Run audit does, step by step',
      body: 'In order: (1) list the in-house stays, (2) post one room charge to each guest folio at that reservation\'s own nightly rate, skipping any already charged, (3) mark confirmed bookings due today that never arrived as No-Show, (4) auto-cancel unconfirmed bookings whose check-in date has passed, (5) snapshot occupancy, (6) count arrivals and departures, (7) total the day\'s revenue and close the day.',
    },
    {
      target: '[data-tour="g-audit-run"]',
      title: 'Run audit: it closes the day',
      body: 'Pressing Run audit asks you to confirm, then performs every step above. Once a day is Closed it cannot be run again, because that would double-charge every guest. Before you press it, finish check-outs and post late charges for the day.',
    },
    {
      target: '[data-tour="g-audit-history"]',
      title: 'History table',
      body: 'One row per business day: Date, Status (Open, Closing, Closed or Failed), Arrivals, Departures, Occupancy %, ADR, RevPAR, then Room, Facility, Other and Total revenue. These closed rows are the data behind the Reports and Revenue pages.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Run the audit after the last check-in and charge of the day, not before. If a run fails the day is marked Failed with a note and a developer or admin should check it, since room charges already posted are protected from being duplicated. Always check the In-house stays count against the Folios you expect before you confirm.',
    },
  ],
};
