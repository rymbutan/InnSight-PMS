export default {
  key: 'settings',
  title: 'Settings',
  steps: [
    {
      title: 'What Settings is for',
      body: 'Settings holds your personal account options and, depending on your role, hotel-wide options. Each section is a collapsible bar that starts closed, so open only the one you came for. What you see depends on your role.',
    },
    {
      target: '[data-tour="g-settings-profile"]',
      title: 'Your profile',
      body: 'Your name, username, main role and email. This is how the rest of the team sees you in chat and in the activity log.',
    },
    {
      target: '[data-tour="g-settings-photo"]',
      title: 'Profile photo',
      body: 'Change Photo uploads a PNG, JPG or WEBP up to 4MB. Remove appears once you have a photo and goes back to your initials.',
    },
    {
      target: '[data-tour="g-settings-account"]',
      title: 'Account Information',
      body: 'Change your username, email or password. Each form asks for your current password. Changing your username signs you out of every device, and a new password signs out your other sessions. Passwords need 8+ characters with upper and lower case, a number and a symbol.',
      try: 'click the bar to open or close the Account Information section.',
    },
    {
      target: '[data-tour="g-settings-billing"]',
      title: 'Billing (Admin and Manager)',
      body: 'Tax Rates sets VAT, Service Charge, Local Tax and Real Property Tax for the hotel\'s country, and applies to charges posted from then on; old charges keep their rates. Payment Processing Fee adds a percentage to card and bank-transfer payments only.',
    },
    {
      target: '[data-tour="g-settings-hotel"]',
      title: 'Hotel Details (Admin and Manager)',
      body: 'Name, address, contacts and website are printed at the top of every guest folio. Check-in and check-out times apply to new and edited bookings (check-out must be earlier than check-in), and the 2-letter Country decides which tax rates apply.',
    },
    {
      target: '[data-tour="g-settings-appearance"]',
      title: 'System Appearance',
      body: 'Theme switches light and dark mode on this device only. Admins also get the System Color Changer, whose three accent colours apply to every user, with Reset to default if it goes wrong.',
    },
    {
      target: '[data-tour="g-settings-messaging"]',
      title: 'Messaging',
      body: 'Message Sound mutes or unmutes the chime on this device only. Admins also see Message Retention, which permanently deletes messages older than the chosen limit for everyone, and saves the moment you pick an option.',
    },
    {
      target: '[data-tour="g-settings-layout"]',
      title: 'Edit System Layout (Admin only)',
      body: 'Choose a role, then tick or untick the sidebar sections that role may see. Dashboard and Settings are always on, and Admin cannot be restricted. Press Save Layout to apply; hidden sections are also blocked if someone types the address.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'If a section from this guide is missing, your role does not include it. Double-check Country and tax rates before billing real guests. Remember that colours and retention affect everyone, while theme and sound affect only your device.',
    },
  ],
};
