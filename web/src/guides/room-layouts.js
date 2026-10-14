export default {
  key: 'room-layouts',
  title: 'Room & Scenario Editor',
  steps: [
    {
      title: 'What this page is for',
      body: 'Admins only. This is where the 3D rooms used in the inspection training are designed. A layout shows a room as it SHOULD be (furniture, walls, stations); a scenario then spoils a room on purpose so students can find the faults.',
    },
    {
      target: '[data-tour="g-room-layouts-tabs"]',
      title: 'Two tabs',
      body: 'Rooms is where you design the correct layout for each room type. Scenarios is the library of deliberately faulty versions. The tab you are on is kept in the address, so a reload brings you back to the same place.',
    },
    {
      target: '[data-tour="g-room-layouts-cards"]',
      title: 'Choose a layout to edit',
      body: 'There is one card for each tier: Standard, Deluxe, Suite and Presidential. Each shows the room size, a floor-plan thumbnail, a short description and the counts of fixtures, stations and interior walls. Layouts you author yourself appear after them with a Custom badge.',
    },
    {
      target: '[data-tour="g-room-layouts-add"]',
      title: 'Adding a new layout',
      body: 'The plus button opens a form to author a layout beyond the four built-in ones. Opening it only shows the form and nothing is created yet.',
      try: 'Click the plus button to open the new-layout form.',
    },
    {
      target: '[data-tour="g-room-layouts-form"]',
      title: 'The new-layout form',
      body: 'Choose "From a room type" to key the layout to a type the hotel actually rents (types that already have a layout are not offered again), or "Custom name" for something like Cabana. Then set the width and length in metres and press Create and open editor. A custom name is only served to students once a room type matches it exactly. Press the plus (now an X) again to close the form.',
    },
    {
      target: '[data-tour="g-room-layouts-cards"]',
      title: 'Editing a layout',
      body: 'Edit layout on any card opens the full-screen 3D editor. The editor needs a mouse and a large screen. For a new layout nothing is saved until you press Save layout, and autosave only starts after that first save.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Layout names allow letters, numbers, spaces, hyphens and underscores, up to 40 characters, and must be unique. Layouts are shared by the whole property, so changing one changes what every student sees for that tier. Use the Scenarios tab next to build the faulty versions.',
    },
  ],
};
