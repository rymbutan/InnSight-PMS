// Keeping displayName in step with a rename.
//
// displayName is the name the rest of the system prints — the reservation forms
// read `guest.displayName`, and so does the registration card. It is set at
// creation to `${firstName} ${lastName}`, but PATCH /api/guests/:id let the two
// drift: Quick Edit sends firstName and lastName and never displayName, so
// correcting a misspelled surname updated the profile while every document went
// on printing the old name.
//
// The rule: refresh displayName on a rename ONLY when the stored one is still
// the auto-derived value. If a human typed something else ("Dr. M. Dela Cruz"),
// a surname correction must not clobber it, and an explicit displayName in the
// patch always wins.

function composeDisplayName({ firstName, lastName } = {}) {
  return [firstName, lastName].filter(Boolean).join(' ').trim();
}

/**
 * @param   {object} before  the guest row as stored
 * @param   {object} patch   the whitelisted fields being written
 * @returns {string|undefined} the display name to write, or undefined to leave it
 */
function nextDisplayName(before, patch = {}) {
  // The caller asked for a specific one; nothing to derive.
  if (patch.displayName !== undefined) return undefined;

  const renaming =
    (patch.firstName !== undefined && patch.firstName !== before?.firstName) ||
    (patch.lastName !== undefined && patch.lastName !== before?.lastName);
  if (!renaming) return undefined;

  // Only touch a name nobody has customised. An empty stored value counts as
  // auto-derived — there is nothing to protect.
  const wasAuto = !before?.displayName || before.displayName === composeDisplayName(before);
  if (!wasAuto) return undefined;

  const next = composeDisplayName({
    firstName: patch.firstName !== undefined ? patch.firstName : before?.firstName,
    lastName: patch.lastName !== undefined ? patch.lastName : before?.lastName,
  });
  return next || undefined;
}

module.exports = { nextDisplayName, composeDisplayName };
