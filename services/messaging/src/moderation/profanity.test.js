const { test } = require('node:test');
const assert = require('node:assert/strict');

const { check } = require('./profanity');

// ─────────────────────────────────────────────────────────────────────────────
// The innocent cases matter MORE than the guilty ones.
//
// A filter that misses a slur is embarrassing. A filter that refuses "please put
// a note on the folio" stops the front desk from doing its job mid-shift, and
// the person it stops has no way to tell whether the system is broken or they
// are. Every line in CLEAN below is a sentence somebody could plausibly type
// into this product, and several are regressions this filter has already had.
// ─────────────────────────────────────────────────────────────────────────────

const CLEAN = [
  // The "put a" trap: a separator-tolerant matcher reads this as "puta".
  'Please put a note on the folio for room 412.',
  'Put a DND tag on 305.',
  // The Scunthorpe family — a banned word sitting inside an innocent one.
  'Can you assist with the class booking?',
  'The analysis of last night audit is done.',
  'Assign the assets to the correct account.',
  'Assessment complete, the guest has passed through.',
  'Association of Hotels meeting at 10.',
  'The Scunthorpe branch confirmed their group rate.',
  'There is a raccoon near the bins again.',
  'Titles for the revenue report are wrong.',
  'The arsenal of spare towels is running low.',
  'Bass speakers in the function room need testing.',
  // Restaurant and housekeeping vocabulary that overlaps the word list.
  'Guest requested a cocktail and shiitake mushrooms.',
  'The spices are low — order more spicy sauce.',
  'Leche flan for table 4 please.',
  'Pest control is booked for 3pm.',
  // Tagalog that collides with the list: "paki-" is a politeness prefix.
  'Paki-check ang room 305 bago mag-checkout.',
  'Pakisend ang report bukas ng umaga.',
  'Tangay ang bag ng guest sa lobby.',
  // Deliberately excluded as mild rather than obscene.
  'Damn good work on the audit tonight.',
  'Hello, the guest in 210 is asking for towels.',
  'Dick Smith checked in at 2pm.',
  // Numbers must survive leetspeak handling untouched.
  'Rooms 101, 305 and 1001 are ready for inspection.',
  // Short tokens the abbreviation list must NOT reach. "POS" is this product's
  // own amenity point-of-sale, "BS" and "AF" are plausible rate or room codes,
  // and "sht" is how a housekeeper abbreviates "sheet".
  'Post the minibar sale through the POS terminal.',
  'Rate code BS applies to the AF block this week.',
  'Room 214 needs 2 sht and 1 blanket.',
];

const DIRTY = [
  // Plain.
  'what the fuck is this',
  'you are a bitch',
  'this is bullshit',
  'motherfucker',
  // Repeated characters.
  'fuuuuck this shift',
  'fuckkk',
  // Leetspeak.
  'sh1t happens',
  'you @sshole',
  'pu74 ka',
  // Full separator evasion — a separator between every letter.
  'f u c k this',
  's.h.i.t',
  'p-u-t-a',
  // Tagalog and Bisaya, closed up and spaced.
  'putangina mo',
  'putang ina mo',
  'tang ina',
  'gago ka talaga',
  'yawa ka',
  'hayop ka',
  'leche ka',
  'tarantado',
  // Slurs.
  'stop being a retard',
  'faggot',
  // Abbreviations and textspeak.
  'wtf is going on',
  'stfu',
  'ffs this again',
  'omfg',
  'lmfao',
  'tangna naman',
  'putragis',
];

test('ordinary hotel messages are never blocked', () => {
  for (const text of CLEAN) {
    const { clean, matches } = check(text);
    assert.ok(clean, `false positive on ${JSON.stringify(text)} — matched ${matches.join(', ')}`);
  }
});

test('profanity is caught, including repeats, leetspeak and separator evasion', () => {
  for (const text of DIRTY) {
    assert.ok(check(text).clean === false, `missed profanity in ${JSON.stringify(text)}`);
  }
});

test('matches report the canonical list entry, not the sender text', () => {
  // A rejection gets logged; the log must be able to say WHAT rule fired without
  // copying the message that was refused into the log file.
  const { matches } = check('fuuuuck');
  assert.deepEqual(matches, ['fuck']);
});

test('an empty or whitespace body is clean rather than throwing', () => {
  for (const text of ['', '   ', '\n']) assert.ok(check(text).clean);
});

test('a long body is checked in reasonable time', () => {
  // Bounded quantifiers are load-bearing: unbounded ones backtrack over long
  // runs of one character and turn a 4000-character message into a stall.
  const body = 'a'.repeat(4000);
  const started = Date.now();
  check(body);
  assert.ok(Date.now() - started < 500, 'profanity check took too long on a max-length body');
});
