export default {
  key: 'health',
  title: 'Service Health',
  steps: [
    {
      title: 'What this page is for',
      body: 'The PMS is made of several small services (reservations, folios, rooms, and so on) working together. This Admin-only page checks that each one is alive, so you can tell quickly whether a problem is "the system is down" or just a user mistake.',
    },
    {
      target: '[data-tour="g-health-mail"]',
      title: 'Outbound email',
      body: 'This card shows whether the system can actually send email, such as password-reset links. Delivering is healthy. Capture-only or not configured means emails are not reaching anyone, even though the app still says "link sent". It also shows the sending server and address.',
    },
    {
      target: '[data-tour="g-health-overall"]',
      title: 'Overall status',
      body: 'A single badge: up when every service answered correctly, otherwise a warning colour. Check this first.',
    },
    {
      target: '[data-tour="g-health-table"]',
      title: 'Per-service table',
      body: 'Each row is one service with its Status, the HTTP code it replied with (200 means fine), its Latency in milliseconds, and any error in Notes. Slow latency or an error on one row tells you which feature to suspect.',
    },
    {
      target: '[data-tour="g-health-refresh"]',
      title: 'Refresh',
      body: 'The page re-checks by itself every 15 seconds and shows the time of the last check. Press Refresh to check right now, for example just after restarting something.',
    },
    {
      title: 'Tips',
      body: 'If a single service is down, only the pages that rely on it will misbehave, so report which row is red. This page is read-only: it cannot restart anything, and it is visible to Admins only.',
    },
  ],
};
