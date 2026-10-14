export default {
  key: 'inspection-scenarios',
  title: 'Inspection Scenarios',
  steps: [
    {
      title: 'What scenarios are',
      body: 'Admins only. A scenario is a specific room prepared to be wrong: a sofa blocking the bathroom door, a vacuum left mid-floor, too few towels for the party. It also carries the booking those faults are wrong for. Whatever you author here is what every student inspects, on any computer.',
    },
    {
      target: '[data-tour="g-inspection-scenarios-list"]',
      title: 'Your scenario library',
      body: 'Each card shows the scenario name, the room type (tier) it is for, whether it is Active or Disabled, and how many faults and decoys it holds. Decoys are correct items that look suspicious, so students must inspect rather than flag whatever lights up. A warning mark means no decoys at all.',
    },
    {
      title: 'Activate, Disable, Edit, Delete',
      body: 'Activate puts a scenario in play so students of that tier may be handed it. Disable stops serving it without losing it. Edit loads it into the editor. The red trash button deletes it for good after a confirmation. The button for the state it is already in is greyed out.',
    },
    {
      target: '[data-tour="g-inspection-scenarios-new"]',
      title: 'Starting a new scenario',
      body: 'New Scenario opens the 3D editor with a blank scenario. You choose a room tier, place faults and decoys in the room, set the booking, and save. Nothing is saved until you press Save in the editor, and refreshing the page mid-edit loses unsaved work.',
    },
    {
      title: 'Where scenarios get used',
      body: 'When a student inspects a room, the system uses the scenario pinned to that room (set from the room panel on Map & Housekeeping). With no pin it draws an active scenario for the tier, or generates faults if there is none, so students are never blocked while you build the library.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Write scenarios for the right tier, because a Suite fault does not exist in a Standard room. Include a few decoys. Make the booking matter: some faults are only wrong relative to party size or requests. Remember to Activate a new scenario, as saving alone may leave it unused.',
    },
  ],
};
