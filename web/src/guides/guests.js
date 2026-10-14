// Guide for /guests — see guides/index.js for the format.
export default {
  key: 'guests',
  title: 'Guest Profiles',
  steps: [
    {
      title: 'What this page is for',
      body: 'A guest profile is the hotel\'s permanent record of one person: name, nationality, VIP level, preferences and their booking history. Reservations and stays link back to it, so a returning guest is recognised instead of retyped.',
    },
    {
      target: '[data-tour="g-guests-create"]',
      title: 'Create a guest',
      body: 'First name and last name are required; nationality is optional. Search first so you do not create a duplicate, then press Create. The new profile gets a profile number such as the one shown in the green confirmation message.',
    },
    {
      target: '[data-tour="g-guests-vip"]',
      title: 'VIP level',
      body: 'None, Silver, Gold or Platinum flag guests who deserve extra attention (upgrades, welcome amenities). Blacklisted marks a guest the hotel does not want to host again, so use it carefully and only per policy.',
      try: 'Open the VIP level list to see the options (then close it without changing anything).',
    },
    {
      target: '[data-tour="g-guests-search"]',
      title: 'Search by name or profile number',
      body: 'Type and the table below narrows live after a short pause. Press Enter to commit: a single match opens straight away. Escape or "Show all" returns to the recent-profiles list.',
    },
    {
      target: '[data-tour="g-guests-list"]',
      title: 'The results list',
      body: 'Each row shows profile number, name, nationality and VIP level. Click anywhere on a row (or press Enter on it) to open that guest. With nobody typed in, this shows the most recent profiles.',
    },
    {
      target: '[data-tour="g-guests-profile"]',
      title: 'The guest card',
      body: 'Choosing a guest replaces the list with a read-only card, so you cannot change a record by accident. The header buttons are Edit, Send to colleague (shares the profile into a chat), Close, and Delete (admins and managers only). Pick a guest to see it.',
    },
    {
      target: '[data-tour="g-guests-facts"]',
      title: 'Status at a glance',
      body: 'Guest status shows whether they are in-house right now, with check-in time and room number if so. You also see nationality, VIP level, number of past stays, and company or bank on file when those exist.',
    },
    {
      target: '[data-tour="g-guests-history"]',
      title: 'Add-ons, reservations and past stays',
      body: 'Below the facts you see saved add-on preferences, every booked reservation (confirmation number, dates, source, status) and completed stays. Use it to answer "has this guest stayed before?" in seconds.',
    },
    {
      target: '[data-tour="g-guests-edit"]',
      title: 'Editing a profile',
      body: 'Edit opens the form for names, nationality, VIP level, company details, saved bank accounts and add-on preferences. Bank accounts and preference checkboxes save the moment you click them; the other fields only save when you press Save.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Always search before creating, because duplicate profiles split a guest\'s history. A guest who is checked in cannot be deleted; check them out first. Delete is permanent, so keep the history intact where the hotel needs it.',
    },
  ],
};
