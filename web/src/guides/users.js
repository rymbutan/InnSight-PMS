export default {
  key: 'users',
  title: 'Users & Roles',
  steps: [
    {
      title: 'What this page is for',
      body: 'Here Admins and Managers decide who can use the system and what they can see. Every account has a username, a status (Active or Disabled) and one or more roles, and the roles control which pages and actions a person gets.',
    },
    {
      target: '[data-tour="g-users-requests"]',
      title: 'Access requests',
      body: 'When someone signs up and asks for access, they appear here with their name, university email, chosen username and reason. Approve opens a dialog to confirm the username and tick roles, then creates the account. Reject refuses it. Approve all gives the same roles to everyone waiting. This panel only shows when requests are pending.',
    },
    {
      target: '[data-tour="g-users-create"]',
      title: 'Create user',
      body: 'Create an account directly: username, display name, optional email and a password of at least 8 characters, then press Create. The new person can sign in straight away with that password.',
    },
    {
      target: '[data-tour="g-users-create-roles"]',
      title: 'Roles',
      body: 'Tick the roles the person needs, such as Front Desk, Housekeeping or Auditor. With no role they can sign in but see nothing. Managers cannot grant the Admin role, so that box only appears for Admins.',
    },
    {
      target: '[data-tour="g-users-search"]',
      title: 'Search the directory',
      body: 'The list narrows as you type: it matches username, name, email and role names, so "front desk" works. Press Esc or Clear to reset. While you filter, a count such as "2 of 14" tells you how many rows are hidden.',
    },
    {
      target: '[data-tour="g-users-table"]',
      title: 'The user table',
      body: 'Admins are pinned at the top, everyone else is A to Z. Status shows Active or Disabled, the role capsules show current access, and Last login shows the last sign-in. The Edit button beside the roles opens a dialog to change them, and nothing changes until you press Save roles.',
    },
    {
      target: '[data-tour="g-users-table"]',
      title: 'Row actions',
      body: 'Reset Password sets a new password and signs the person out everywhere. Disable blocks sign-in and signs them out but keeps their record, so Enable can bring them back. Delete (Admins only) is permanent. You cannot disable or delete your own account, nor the built-in "admin" account.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Prefer Disable over Delete when someone leaves: their work history stays intact and the change is reversible. Give people the fewest roles they need. Managers cannot touch Admin accounts, so those rows show a dash instead of buttons.',
    },
  ],
};
