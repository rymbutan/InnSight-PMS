export default {
  key: 'messages',
  title: 'Messages',
  steps: [
    {
      title: 'What Messages is for',
      body: 'Messages is private chat between staff members, for handovers and quick questions such as "is 204 ready yet?". It is for staff only: guests never see it. Pick a colleague on the left and talk on the right.',
    },
    {
      target: '[data-tour="g-messages-contacts"]',
      title: 'Staff list',
      body: 'Everyone else with an account appears here, split into Online and Offline so you can see who is likely to answer. A number badge shows unread messages, and the last message preview or the person\'s role sits under their name.',
    },
    {
      target: '[data-tour="g-messages-search"]',
      title: 'Search staff',
      body: 'Type part of a name or username to narrow the list. The x button clears it.',
    },
    {
      target: '[data-tour="g-messages-thread"]',
      title: 'The conversation',
      body: 'Choose a person to open your chat with them. Messages are grouped by day and by who sent them, and a "typing" indicator appears while they write. Until you choose someone, this area says "No conversation open".',
    },
    {
      target: '[data-tour="g-messages-composer"]',
      title: 'Writing a message',
      body: 'Press Enter to send and Shift+Enter for a new line. A message can be up to 4,000 characters. Messages containing language the system does not allow are refused: reword it and send again.',
    },
    {
      target: '[data-tour="g-messages-attach"]',
      title: 'Attach a record',
      body: 'The paperclip attaches a reservation, folio or guest to your next message as a clickable chip, so your colleague can open it directly. Which record types you can attach depends on your role, and the clip is hidden if none apply.',
    },
    {
      target: '[data-tour="g-messages-dock"]',
      title: 'Open in dock',
      body: 'This moves the chat into a small floating window that follows you around the system, and takes you back to the page you came from. Handy when you need to keep chatting while you work. It only shows once a conversation is open.',
    },
    {
      target: '[data-tour="g-messages-sound"]',
      title: 'Sound and retention',
      body: 'Sound on/off controls the arrival chime on this device only. If an Admin has set a retention rule, a note such as "Cleared when you sign out" appears beside it, telling you how long your messages will last.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Never put guest passwords or card numbers in a message. Check the name above the thread before sending, since drafts are cleared when you switch person. Use the attach button instead of copying reservation numbers by hand.',
    },
  ],
};
