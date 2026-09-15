// ─────────────────────────────────────────────────────────────────────────────
// PROFANITY FILTER for staff messages.
//
// BLOCK, DON'T MASK
// -----------------
// A rejected send is better than a delivered `****`. Masking still delivers the
// insult — the recipient reads the shape of it and fills in the blanks — while
// the sender never learns anything was wrong. Refusing the send with a plain
// explanation puts the decision back where it belongs: the sender rephrases, and
// what arrives is a message somebody chose to write.
//
// PRECISION OVER RECALL, DELIBERATELY
// -----------------------------------
// The two failure modes are NOT symmetric. A slur that slips through is a moment
// of rudeness. A false positive is a front-desk agent who cannot report a
// medical emergency in room 412 because the filter decided a word looked
// obscene — mid-shift, with a guest waiting. So this errs towards letting things
// through, and the tests in profanity.test.js pin the innocent cases as firmly
// as the guilty ones.
//
// Three specific concessions to that principle:
//
//   1. WHOLE WORDS ONLY. "assist", "class", "Scunthorpe", "analysis",
//      "cocktail", "raccoon" and "shiitake" all pass.
//
//   2. WORDS WITH AN INNOCENT MEANING ARE LEFT OUT ON PURPOSE, not forgotten:
//      dick, prick, cock, screw, balls, nuts (names and ordinary nouns);
//      leche (leche flan is on the menu); peste (pest control); paki (the
//      Tagalog politeness prefix — "paki-check", "pakisend"); spic (a prefix of
//      "spices" and "spicy", both restaurant vocabulary); damn and hell (mild,
//      and overwhelmingly used as ordinary emphasis). Mild irritation is not
//      obscenity — the bar here is obscene, sexual, or a slur, not impolite.
//
//   3. SEPARATOR EVASION IS MATCHED ONLY IN ITS FULL FORM. "f u c k" and
//      "s.h.i.t" are caught because a separator sits between EVERY letter,
//      which is what deliberate evasion looks like. A pattern that allowed
//      separators at only some positions would read "please put a note on the
//      folio" as "puta" and block it. That is not hypothetical — it is the
//      first thing this file got wrong.
//
// FILIPINO TERMS ARE FIRST-CLASS
// ------------------------------
// The property is in the Philippines and staff code-switch constantly; an
// English-only list would catch the least of what actually gets typed. Tagalog
// and Bisaya terms sit in the same list as the English ones.
//
// The other evasions — repeated characters (fuuuck, fuckkk) and leetspeak
// (f@ck, sh1t, @sshole) — are handled in the patterns rather than by rewriting
// the input, so the sender's text is never altered or re-displayed transformed.
// ─────────────────────────────────────────────────────────────────────────────

// Canonical, lowercase, single words. Multi-word expressions live in PHRASES.
const WORDS = [
  // ── English: sexual and scatological ──
  'fuck',
  'fucker',
  'fuckface',
  'fuckhead',
  'fuckwit',
  'fuckboy',
  'motherfucker',
  'motherfucking',
  'clusterfuck',
  'shit',
  'shitty',
  'shithead',
  'shitface',
  'shithole',
  'bullshit',
  'horseshit',
  'dogshit',
  'dipshit',
  'ass',
  'asshole',
  'asshat',
  'assface',
  'jackass',
  'dumbass',
  'arse',
  'arsehole',
  'bitch',
  'bitches',
  'bitchy',
  'sonofabitch',
  'bastard',
  'cunt',
  'twat',
  'wank',
  'wanker',
  'bollocks',
  'piss',
  'cocksucker',
  'dickhead',
  'dickface',
  'pussy',
  'pussies',
  'whore',
  'slut',
  'skank',
  'tits',
  'boner',
  'blowjob',
  'handjob',
  'jerkoff',
  'cumshot',

  // ── English: slurs. Not merely "strong language" — targeted abuse, and the
  // reason this is a moderation filter rather than a politeness setting. ──
  'nigger',
  'nigga',
  'faggot',
  'fag',
  'retard',
  'retarded',
  'tranny',
  'chink',
  'kike',
  'wetback',
  'gook',
  'coon',
  'towelhead',
  'raghead',
  'dyke',

  // ── Tagalog ──
  'putangina',
  'putanginamo',
  'putang',
  'puta',
  'tangina',
  'tanginamo',
  'kingina',
  'punyeta',
  'punyemas',
  'pucha',
  'putcha',
  'gago',
  'gaga',
  'tanga',
  'bobo',
  'ulol',
  'tarantado',
  'hinayupak',
  'siraulo',
  'kupal',
  'pakshet',
  'pakyu',
  'bwisit',
  'buwisit',
  'ungas',
  'engot',
  'inutil',
  'burat',
  'pekpek',
  'puki',
  'titi',
  'otin',
  'jakol',
  'kantot',
  'kantutan',
  'chupa',
  'tangna',
  'tangena',
  'tangine',
  'putragis',
  'pakshit',
  'gagu',
  'bwiset',

  // ── Abbreviations and textspeak ──
  // A separate group because the precision rule bites hardest here: these are
  // short, and a short token is the easiest kind to collide with something
  // legitimate. Three are deliberately absent for exactly that reason —
  // "pos" (this product posts amenity charges from a POS), "bs" (a room or
  // rate code, and a degree) and "af" (two letters, and a plausible code).
  'wtf',
  'wtaf',
  'stfu',
  'gtfo',
  'ffs',
  'omfg',
  'lmfao',
  'mf',
  'mfer',
  'mofo',
  'kys',
  'fck',
  'fuk',
  'fuq',
  'phuck',
  'azz',
  'biatch',
  'beotch',
  'btch',
  'shyt',
  'biyatch',
  'byotch',
  'ahole',

  // ── Bisaya / Cebuano ──
  'yawa',
  'pisti',
  'pesteng',
  'bilat',
  'buang',
  'iyot',
  'lintik',
];

// Expressions whose insult lives in the whole phrase. Written with real spaces;
// each space matches one run of separators, while the letters inside each word
// still have to be adjacent. This is how "putang ina" is caught without putting
// bare "tang" or bare "ina" — both ordinary — anywhere near the word list.
const PHRASES = ['putang ina', 'tang ina', 'hayop ka', 'leche ka', 'pesteng yawa', 'son of a bitch'];

// Common inflections, so the list can hold roots rather than every form. Kept
// short, because each entry is another route by which an innocent word can be
// reached. Notably absent: "y" and "ies" (they turn "spic" into "spicy" and
// "spices"), and the bare vowels "a"/"o" (they turn short entries into prefixes
// of ordinary words). The handful of forms that needs — bitchy, shitty,
// pussies — are listed in full above instead.
const SUFFIX = '(?:s|es|ed|er|ers|ing|ings|in)?';

// Look-arounds rather than \b, because \b is defined on [A-Za-z0-9_] and so
// would refuse to start a match at a leetspeak first character: there is no word
// boundary before the "@" in "@sshole". These say the same thing — "not in the
// middle of a word" — without that gap.
const BEFORE = '(?<![a-z0-9])';
const AFTER = '(?![a-z0-9])';

// Leetspeak equivalences, expressed as character classes inside the pattern.
// Doing it here rather than by rewriting the input matters: substituting on the
// input would turn "room 101" into "room ioi" and invent words nobody typed.
const LEET = {
  a: 'a@4',
  b: 'b8',
  e: 'e3',
  g: 'g9',
  i: 'i1!',
  l: 'l1|',
  o: 'o0',
  s: 's$5',
  t: 't7',
  z: 'z2',
};

function charClass(ch) {
  const alts = LEET[ch];
  if (alts) return `[${alts}]`;
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// {1,2} rather than + because normalize() caps every run of a character at two.
// Bounded quantifiers keep matching linear; unbounded ones, run over a
// 4000-character body, are how a filter turns into a denial-of-service vector.
const letterPattern = (ch) => `${charClass(ch)}{1,2}`;

function tightPattern(word) {
  const core = [...word].map(letterPattern).join('');
  return new RegExp(`${BEFORE}${core}${SUFFIX}${AFTER}`);
}

// The full-evasion form: a separator between EVERY letter ("f u c k", "s.h.i.t",
// "p-u-t-a"). Only built for words of four letters or more — on three, the
// spaced form is too easy to hit by accident.
function spacedPattern(word) {
  if (word.length < 4) return null;
  const core = [...word].map(letterPattern).join('[^a-z0-9]{1,3}');
  return new RegExp(`${BEFORE}${core}${AFTER}`);
}

// A phrase: letters adjacent within each word, one run of separators between.
function phrasePattern(phrase) {
  const core = phrase
    .split(' ')
    .map((w) => [...w].map(letterPattern).join(''))
    .join('[^a-z0-9]{1,3}');
  return new RegExp(`${BEFORE}${core}${SUFFIX}${AFTER}`);
}

const PATTERNS = [
  ...WORDS.flatMap((word) => {
    const spaced = spacedPattern(word);
    return spaced
      ? [
          { word, re: tightPattern(word) },
          { word, re: spaced },
        ]
      : [{ word, re: tightPattern(word) }];
  }),
  ...PHRASES.map((phrase) => ({ word: phrase, re: phrasePattern(phrase) })),
];

// Lowercase, strip diacritics, and cap every run of one character at two. The
// cap is what puts "fuuuuuck" within reach of a {1,2} quantifier, and what stops
// the patterns backtracking across a long run.
function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');
}

// → { clean, matches }. `matches` holds the CANONICAL list entries that fired,
// never the caller's own words: it exists so a rejection can be logged or
// counted without writing the refused message into a log file.
function check(text) {
  const normalized = normalize(text);
  const matches = [];
  for (const { word, re } of PATTERNS) {
    if (re.test(normalized) && !matches.includes(word)) matches.push(word);
  }
  return { clean: matches.length === 0, matches };
}

module.exports = { check, normalize, WORDS, PHRASES };
