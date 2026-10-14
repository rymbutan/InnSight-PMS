// Guide for the inspection-shift — see guides/useInlineGuide.js.
export default {
  key: 'inspection-shift',
  title: 'Room inspection',
  steps: [
    {
      title: 'What this inspection is for',
      body: 'You are checking a room that someone else cleaned, judging it against the guest booking. A pass means the room is guest-ready: you found every real fault, named each one correctly, and did not accuse anything that was fine.',
    },
    {
      title: 'What happens to the room',
      body: 'Pass, and the room becomes Vacant Clean (or Vacant Clean Inspected if you are signing off as a supervisor). Fail, and it stays or goes back to Vacant Dirty so it can be re-cleaned. The clock is paused while this guide is open.',
    },
    {
      title: 'Walking and looking (keyboard and mouse)',
      body: 'Click the room once to capture the mouse, then look with the mouse and walk with W A S D or the arrow keys. Press Esc to release the pointer when you need it back.',
    },
    {
      title: 'Walking and looking (touch)',
      body: 'On a phone or tablet, touch and drag on the left half of the screen to walk with the floating joystick, and drag on the right half to look around. The Inspect button appears when you are aiming at something.',
    },
    {
      target: '[data-tour="g-inspection-hint"]',
      title: 'The hint bar',
      body: 'This bar reminds you of the controls for your device and tells you whether the pointer is currently captured.',
    },
    {
      title: 'Read the booking first',
      body: 'The clipboard shows who is arriving: guest name, how many adults and children, room type, nights, and any special requests. Faults only make sense against it, for example twin beds are wrong if a couple is arriving, and a requested extra should actually be in the room.',
    },
    {
      target: '[data-tour="g-inspection-booking"]',
      title: 'Reopen the booking any time',
      body: 'The Booking button (or the C key) shows and hides the clipboard, so re-read it whenever you are unsure.',
      try: 'click Booking (C) to hide or show the clipboard.',
    },
    {
      target: '[data-tour="g-inspection-crosshair"]',
      title: 'Aim the crosshair',
      body: 'The dot in the middle of the view is your aim. Walk up to furniture, bedding, the bathroom, the minibar and other objects, and centre the crosshair on them. Nothing is highlighted until you aim at it, so you have to look properly.',
    },
    {
      title: 'Inspect an object',
      body: 'When the crosshair is on something you can check, a prompt names it. Click or press E (or tap Inspect on touch) to open it. Items you have already reviewed turn green and stop being targets.',
    },
    {
      title: 'Choose a category, or mark it correct',
      body: 'The menu asks what is wrong, if anything. Pick the fault category that fits, because a missed restock and an attendant leaving something behind are fixed by different people. If the object is fine, choose "This is correct - no issue". Cancel lets you keep looking.',
    },
    {
      title: 'Why false alarms hurt',
      body: 'Flagging something that is actually fine counts against your inspection precision and sends attendants back to a clean room. Marking something correct that is actually faulty counts as a miss, so judge each item against the booking.',
    },
    {
      target: '[data-tour="g-inspection-progress"]',
      title: 'Track your progress',
      body: 'This counter shows how many items you have reviewed out of the total in the room. Every item needs a decision, either a fault category or "correct".',
    },
    {
      target: '[data-tour="g-inspection-finish"]',
      title: 'Finishing',
      body: 'Finish inspection stays greyed out until every item has been reviewed, and shows how many are left. Once it is available, press it to see your result. Leave exits without grading.',
    },
    {
      title: 'Reading the result',
      body: 'The assessment lists each real fault as found or missed, whether you named it correctly, and an inspection precision line for false alarms. Only a perfect run passes the room; otherwise read the feedback and try again. The ? button reopens this guide.',
    },
  ],
};
