export default {
  key: 'housekeeping',
  title: 'Map & Housekeeping',
  steps: [
    {
      title: 'The hotel at a glance',
      body: 'This page is the live board of every room: which are dirty, clean, inspected, occupied or out of use. Housekeeping, front desk and managers all work from it, and it repaints by itself when anyone changes a room anywhere in the system.',
    },
    {
      target: '[data-tour="g-housekeeping-occupancy"]',
      title: 'Occupancy',
      body: 'The share of all rooms that are currently Occupied. It is a quick health check for the day: a low number with lots of red rooms means turnover work is blocking sales.',
    },
    {
      target: '[data-tour="g-housekeeping-map"]',
      title: 'The room map',
      body: 'Each tile is one room, grouped by floor along a corridor. It shows the room number, its type and a coloured status badge. Hover a room (on a mouse) for a tooltip with rate and status, or click or tap it to open its panel. Click it again to deselect. On a phone, drag to pan, pinch to zoom, and use the Floor buttons above the map to jump.',
    },
    {
      target: '[data-tour="g-housekeeping-legend"]',
      title: 'Status colours and codes',
      body: 'VD Vacant Dirty (red) needs cleaning. VC Vacant Clean (green) is cleaned but awaits a supervisor. VCI Vacant Clean Inspected (blue) is guest-ready. OCC Occupied (violet) has a guest in it. OOS Out of Service (amber) is minor servicing. OOO Out of Order (slate) is major repair. The number in brackets is how many rooms are in each state right now.',
    },
    {
      title: 'The Dirty, Clean, Inspected workflow',
      body: 'After checkout a room becomes VD. Housekeeping turns it over and it becomes VC. A supervisor then inspects it and signs it off as VCI, and only then is it ready for the front desk to give to a guest. Two separate steps, by two separate people, on purpose: nobody certifies their own work.',
    },
    {
      target: '[data-tour="g-housekeeping-detail"]',
      title: 'The room panel',
      body: 'Selecting a room opens this panel with its status, type, rate, floor, capacity and who it is assigned to. Everything you can do to the room is here, and the actions change with its status. (It only appears after you select a room, so click one on the map to follow along.)',
    },
    {
      target: '[data-tour="g-housekeeping-assign"]',
      title: 'Assigning a housekeeper',
      body: 'Admins, managers and front desk can choose who is responsible for the room. Assign first: the Call button below only works for a room that has a named housekeeper, so the right person is rung and nobody else is disturbed.',
    },
    {
      target: '[data-tour="g-housekeeping-call"]',
      title: 'Calling housekeeping',
      body: 'Front desk cannot change a room to dirty themselves, so they ring housekeeping instead. Pick a reason (cleaning, spill, linens, turndown, ready for inspection, other), add an optional message, then press Call. The assigned housekeeper is notified and you get a toast when they answer.',
    },
    {
      target: '[data-tour="g-housekeeping-scenario"]',
      title: 'Pinning an inspection scenario',
      body: 'Admins and managers can pin a prepared scenario to a room so every student inspecting it meets exactly the same hidden faults. Only scenarios written for that room type are listed. Leave it on automatic and faults are generated or drawn from the library.',
    },
    {
      target: '[data-tour="g-housekeeping-actions"]',
      title: 'Actions per status',
      body: 'Dirty: "Turn Room Over Against Booking" starts the turnover (housekeeping, managers and admins). Clean: "Inspect & Sign Off Room" (admin, manager, front desk only; a housekeeper just sees a note that a supervisor must do it). Clean or Inspected can be sent back with "Report Inadequate Cleaning". "Mark Out of Service" and "Mark Out of Order" ask you to confirm because they remove the room from sale. Out of order and out of service rooms have Restore Room or Return to Service, which sends them to Dirty. Occupied rooms are controlled by check-in and check-out, not here.',
    },
    {
      title: 'How a turnover passes or fails',
      body: 'The inspection opens the room against its real booking. You pass only if you find every hidden fault AND pick the right category for each one AND do not report anything that was actually fine. Anything less is a fail: the room stays Dirty, a red result appears in the panel, and you re-clean it. A pass by housekeeping makes the room Vacant Clean; a pass by an admin, manager or front desk makes it Inspected. Every run is saved to the training record.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Do not flag everything: false alarms are scored separately and fail the room. Name the category of each fault, because spotting it is only half the job. Check the room type and booking on the clipboard before judging what is missing. Use Out of Order only for real repairs; use Out of Service for short jobs.',
    },
  ],
};
