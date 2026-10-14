// Guide for the scenario editor (inspection case-study builder) — see guides/useInlineGuide.js.
// Only the two `try` steps (the Scenario and Build tab buttons) are interactive; both just
// switch a panel tab and write nothing.
export default {
  key: 'scenario-editor',
  title: 'Building an inspection scenario',
  steps: [
    {
      target: '[data-tour="g-scenario-editor-panel"]',
      title: 'What you are building',
      body: 'A scenario is a room that is deliberately NOT right: a rushed turnover with a few real faults hidden among normal objects. What you set up here is exactly what the trainee walks into, so you edit the room into its faulted state and tag what is wrong.',
    },
    {
      target: '[data-tour="g-scenario-editor-tab-scenario"]',
      title: 'Start on the Scenario tab',
      body: 'The left panel has three tabs: Build (objects), Scenario (tier and name) and Faults (the category library). Tier and name live on the Scenario tab.',
      try: 'click the Scenario tab.',
    },
    {
      target: '[data-tour="g-scenario-editor-tier"]',
      title: 'Pick a room tier and name it',
      body: 'Choose Standard, Deluxe, Suite or Presidential; the 3D room redraws from that tier\'s layout. Then give it a clear name such as "Couple in a twin room". Heads up: the tier is locked once the scenario has been created.',
    },
    {
      target: '[data-tour="g-scenario-editor-stage"]',
      title: 'The 3D stage',
      body: 'Drag to orbit the room, scroll or pinch to zoom, and click any object to select it. A red dot above an object marks a fault. That dot is for you only; students never see it.',
    },
    {
      target: '[data-tour="g-scenario-editor-gizmo"]',
      title: 'Moving and turning things',
      body: 'With an object selected, Move (M) and Rotate (R) show a gizmo on it. Rotation is horizontal only. The camera buttons on the left of this bar jump to a bird\'s-eye or default view, and Undo/Redo (Ctrl+Z / Ctrl+Y) cover your last 20 edits.',
    },
    {
      target: '[data-tour="g-scenario-editor-tab-build"]',
      title: 'Back to the Build tab',
      body: 'Build is where you spend most of your time: adding objects and editing the selected one. Clicking an object in the 3D view brings you here automatically.',
      try: 'click the Build tab.',
    },
    {
      target: '[data-tour="g-scenario-editor-add-select"]',
      title: 'Add or reposition objects',
      body: 'Pick a prop (vacuum, mop bucket, chemicals, unmade bedding, luggage rack) or any room asset, then press "Add to room". Or select something already in the room and drag it, nudge it with the Placement controls (rotation, height off the floor, size), or swap it for a variant.',
    },
    {
      target: '[data-tour="g-scenario-editor-fault"]',
      title: 'Placing a fault: the "What the student should find" menu',
      body: 'Select an object first (this card shows once one is selected). The menu has three kinds of answer: "Not inspectable (scenery)", "Inspectable, but correct (decoy)", or a fault category. Choosing a category makes the object a fault the trainee must find.',
    },
    {
      target: '[data-tour="g-scenario-editor-tab-faults"]',
      title: 'Fault categories, built-in and custom',
      body: 'Open the Faults tab to see the six built-in categories plus any custom ones. To add your own, fill in a name, a required "why it is a fault" (the trainee reads this after grading) and an optional coaching note, then press "Add category". It is saved to a shared library for every scenario and room, and "Retire" removes a custom one.',
    },
    {
      target: '[data-tour="g-scenario-editor-counts"]',
      title: 'Decoys and why they matter',
      body: 'This counter shows your faults and decoys. A decoy is a clickable object that is actually fine. Grading rewards finding every fault and giving it the right category, and it penalises flagging clean items, so with no decoys students learn to flag whatever lights up. Aim for several decoys.',
    },
    {
      title: 'The booking is not set here',
      body: 'There is no booking form in this editor. When a student inspects a real room, the clipboard comes from that room\'s actual reservation, so one scenario works on any room of its tier. A fault the booking cannot support (twin beds for a solo guest) is treated as a clean decoy, so tag what is wrong with the room itself.',
    },
    {
      target: '[data-tour="g-scenario-editor-save"]',
      title: 'Save and preview',
      body: 'A scenario needs a name and at least one fault. "Create scenario" saves it (Ctrl+S works too), and after that edits autosave. "Preview" runs the real inspection as a student with recording off, so it never touches anyone\'s record. Nothing autosaves before the first Create.',
    },
    {
      target: '[data-tour="g-scenario-editor-saved"]',
      title: 'Activate, disable, edit or delete',
      body: 'Each saved scenario can be Activated or Disabled. Only active ones may be handed to students inspecting rooms of that tier; with none active, they get generated faults instead. "Edit" reopens one, and the trash button deletes it for good. The "+ New Scenario" button starts a blank one.',
    },
  ],
};
