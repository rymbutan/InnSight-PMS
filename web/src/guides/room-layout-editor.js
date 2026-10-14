// Guide for the 3D room layout editor — see guides/useInlineGuide.js.
const t = (name) => `[data-tour="g-layout-editor-${name}"]`;

export default {
  key: 'room-layout-editor',
  title: 'Room layout editor',
  steps: [
    {
      target: t('title'),
      title: 'Welcome to the layout editor',
      body: 'This is where you dress a room in 3D. The name here is the room type you are editing, and your changes become the layout every guest-room scene and training exercise uses.',
    },
    {
      target: t('viewport'),
      title: 'The 3D viewport',
      body: 'Drag to orbit around the room, scroll to zoom, and right-drag to pan. On a touch screen, one finger orbits and two fingers zoom and pan. Click an object to select it; click empty floor to deselect.',
    },
    {
      target: t('camera'),
      title: 'Jump to a better view',
      body: 'Bird’s-eye looks straight down on the floor plan, which is the easiest angle for lining things up. The house button next to it returns to the normal three-quarter view.',
      try: 'click Bird’s-eye view, then use the house button to come back. It only moves the camera.',
    },
    {
      target: t('palette-tabs'),
      title: 'The catalogue',
      body: 'Everything you can add lives in the palette on the left. Models are 3D furniture files, Types are simple built-in shapes like rugs and panels, and All shows both. Use the search box to filter by name, or import your own .glb model with the upload button.',
      try: 'click the Types tab to browse the built-in shapes.',
    },
    {
      target: t('add'),
      title: 'Placing an item',
      body: 'Click a card to preview it, then press the + button, or just double-click the card. The new item lands at the room centre and is selected straight away. Walls and task stations have their own Wall and Station buttons just below.',
    },
    {
      target: t('gizmo'),
      title: 'Move, rotate, resize',
      body: 'These three tools decide what the arrows in the viewport do. Press M for Move, R for Rotate, T for Resize. Drag a coloured handle on the selected item. Shift-click adds more items to the selection, and Ctrl/⌘+A selects everything.',
    },
    {
      target: t('inspector'),
      title: 'Exact values in the Inspector',
      body: 'With one item selected, type exact position, rotation, scale and height here, tick “solid (collision)” so people cannot walk through it, or pick a colour. Arrow keys nudge the selection by 10 cm, Ctrl/⌘+D duplicates it, and Delete removes it.',
    },
    {
      target: t('lists'),
      title: 'Find things in the lists',
      body: 'Every furniture piece, wall and station is listed here, which is handy when something is hidden behind something else. Click a row to select it, or Shift-click a second row to select a range.',
    },
    {
      target: t('room'),
      title: 'Room size and spawn point',
      body: 'Floor colour, width, length and height are set here, along with the spawn spot where a player enters the room. Changing these resizes the room for this layout. Sizes must stay above zero, and the spawn spot is pulled back inside the room if you shrink it. Items are not moved, so check nothing is left outside.',
    },
    {
      target: t('snap'),
      title: 'Snapping',
      body: 'With the magnet on, dragging moves in 10 cm steps, rotates in 15° steps and resizes in 0.1 steps, which keeps things tidy. Turn it off for freehand placement. It does not affect numbers you type in the Inspector.',
    },
    {
      target: t('undo'),
      title: 'Undo and redo',
      body: 'Ctrl/⌘+Z undoes the last placement, move, nudge, duplicate, delete or Inspector edit (up to 60 steps), and Ctrl+Y or Shift+⌘+Z redoes. Everything you type into one Inspector or Room field counts as a single step. Undo while a field is still focused acts on the text box, so click away from it first.',
    },
    {
      target: t('save-as'),
      title: 'Saving: it autosaves',
      body: 'There is no Save button for an existing layout. About a second after you stop editing it saves to the server for everyone, and the status chip beside this button shows Saving or Saved. A brand-new layout shows “Not saved yet” and a Save layout button instead, and is not stored until you press it (or Ctrl/⌘+S). Save as copies the room under a new name and leaves the original untouched, and asks first if that name is already taken.',
    },
    {
      target: t('reset'),
      title: 'Careful: Reset to file',
      body: 'Available for the four built-in room types only. It discards the saved layout for that type, for every browser, and goes back to the one built into the code. Undo cannot bring it back, so only use it when you really want a fresh start. Layouts you created yourself have nothing built in to go back to, so the button is hidden for them.',
    },
    {
      target: t('close'),
      title: 'Leaving safely',
      body: 'Press the X to close: any edit still waiting is sent first, and you are asked before closing a layout that was never saved or whose last save failed. Because everything is saved live, there is nothing to “publish”. Tips: use bird’s-eye to line things up, keep the guide button handy, and the question-mark button in the toolbar lists every shortcut. Press the guide button any time to replay this tour.',
    },
  ],
};
