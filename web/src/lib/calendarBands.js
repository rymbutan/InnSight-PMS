// Length-of-stay banding for the calendar's secondary color cue (Changes-to-
// be-made doc, item 1). Deliberately independent of status color, which
// encodes reservation state and must not be touched by this.
export function stayLengthBand(nights) {
  if (nights <= 2) return 'short';
  if (nights <= 6) return 'medium';
  return 'long';
}
