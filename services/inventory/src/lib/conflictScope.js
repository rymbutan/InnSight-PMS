// Which physical spaces a facility booking actually occupies.
//
// A large space can be divided (Changes-to-be-made doc, item 2: the grand
// function hall splits into meeting rooms). Booking the whole hall consumes
// every section; booking one section consumes only that section. Expressing a
// booking as the SET OF LEAVES it occupies makes the conflict rule a plain
// intersection test:
//
//   hall vs section A   → {a,b,c} ∩ {a} = {a}  → clash
//   section A vs A      → {a} ∩ {a}     = {a}  → clash
//   section A vs B      → {a} ∩ {b}     = {}   → no clash  ← siblings are independent
//
// It is also what lets a single Postgres exclusion constraint enforce the rule:
// see the FacilitySlotLock table in migrations/20260818000100_divisible_facilities.
function leafFacilityIds(facility, children) {
  const kids = Array.isArray(children) ? children : [];
  if (kids.length === 0) return [facility.id];
  return kids.map((c) => c.id);
}

module.exports = { leafFacilityIds };
