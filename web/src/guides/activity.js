export default {
  key: 'activity',
  title: 'Activity Log',
  steps: [
    {
      title: 'What the Activity Log is',
      body: 'This Admin-only page is the system\'s record of who did what. Every successful change in any part of the system is written here, newest first. It is read-only: entries cannot be edited or deleted, which is what makes it trustworthy.',
    },
    {
      target: '[data-tour="g-activity-filters"]',
      title: 'Filters',
      body: 'Narrow the log with a From and To date, a User, an Area (which part of the system), an Action type, and free-text Search. Filters combine, and changing one returns you to page 1.',
    },
    {
      target: '[data-tour="g-activity-user"]',
      title: 'Filter by person',
      body: 'Pick one staff member to see only their changes, for example to check what a trainee did during a shift. The list is built from everyone who appears in the log, not just the rows on screen.',
      try: 'open the User dropdown to see who has activity, then pick one or press Esc.',
    },
    {
      target: '[data-tour="g-activity-search"]',
      title: 'Search',
      body: 'Type a name, a request path or a record id (such as a reservation or folio id). Results update about a third of a second after you stop typing.',
    },
    {
      target: '[data-tour="g-activity-bar"]',
      title: 'Counts, Clear and Refresh',
      body: 'This line shows which rows you are viewing, such as "1-50 of 312", and how many filters are active. Clear filters resets everything, and Refresh reloads the newest entries.',
    },
    {
      target: '[data-tour="g-activity-table"]',
      title: 'Reading a row',
      body: 'When is the time of the change. Who is the person and their role. Did what is a plain-English summary with the technical request underneath. Area is the part of the system, and Record is the id of the thing that was changed. Hover a time to see the exact timestamp.',
    },
    {
      target: '[data-tour="g-activity-pager"]',
      title: 'Paging',
      body: 'Fifty entries are shown per page. Use Previous and Next to move through older entries. This bar only appears when there is more than one page.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Only changes are logged: viewing a record, searching, and refused or failed attempts are not. If you cannot find something, widen the date range or clear a filter before assuming it did not happen.',
    },
  ],
};
