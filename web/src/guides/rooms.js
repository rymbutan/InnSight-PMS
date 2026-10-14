export default {
  key: 'rooms',
  title: 'Hotel Rooms',
  steps: [
    {
      title: 'What this page is for',
      body: 'This is the property register: every physical room, plus the room types and nightly rates that define them. Admins can edit all of it. Managers get a view of the rooms and rates, as the note at the top explains. Front desk and housekeeping use the Map & Housekeeping page instead.',
    },
    {
      target: '[data-tour="g-rooms-list"]',
      title: 'The room list',
      body: 'One row per room: number, type code, floor, a coloured status badge and a Change control. The colours match the Map & Housekeeping board exactly, so a green row here is a green room there. Only this list scrolls; the filters and the rates panel stay put.',
    },
    {
      target: '[data-tour="g-rooms-type-filter"]',
      title: 'Filter by type',
      body: 'A full hotel has hundreds of rooms, so narrow the list first. This dropdown limits it to one room type by its code.',
      try: 'Open the Type dropdown to see the room type codes.',
    },
    {
      target: '[data-tour="g-rooms-filters"]',
      title: 'Filter by status',
      body: 'The Status dropdown beside it limits the list to, say, only Dirty or Out of Order rooms. The two filters combine, and the count on the right (for example "12 of 45") shows how many rooms match. Choose "All" to clear a filter.',
    },
    {
      target: '[data-tour="g-rooms-list"]',
      title: "Changing a room's status",
      body: "The Change dropdown on a row sets that room's status immediately, with no confirmation, so be careful. It is a manual override for fixing mistakes. The normal workflow (dirty, clean, inspected) runs through the inspection on the Map & Housekeeping page.",
    },
    {
      target: '[data-tour="g-rooms-types"]',
      title: 'Room types and rates',
      body: 'Each card is a room type: its name, nightly rate in pesos, code, how many guests it sleeps and how many rooms it has. The rate here is what the reservation screens charge per night.',
    },
    {
      target: '[data-tour="g-rooms-types"]',
      title: 'Editing a type (admin)',
      body: 'Admins see a quick price box with Save for the weekly rate change, an Edit button for name, sleeps, room count and rate, and a trash button. Delete only works for a type with no rooms and no live holds, and it cannot be undone. Managers do not see these controls.',
    },
    {
      target: '[data-tour="g-rooms-add"]',
      title: 'Adding rooms and types (admin)',
      body: 'The plus button replaces the rates panel with two forms: Add Room (number, type, floor) and Create Room Type (code, name, base rate, max occupancy, inventory). Create the type first, because a room needs a type to belong to. The X in that panel returns you to the rates.',
    },
    {
      title: 'Tips and common mistakes',
      body: 'Rates are entered in pesos, not centavos. Room numbers should be unique. Do not use Change to mark a room Occupied; check-in does that. Promo codes are not here: they live under Amenities & Facilities. Arriving from the global search highlights the room you were looking for.',
    },
  ],
};
