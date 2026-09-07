-- Stamp the property's service times onto existing booking windows.
--
-- Reservation.checkIn/checkOut have always been timestamps, and
-- Reservation_no_double_booking compares them as tsrange(checkIn, checkOut, '[)').
-- Every row written before this stored midnight for both ends, so the range said
-- "the whole of the arrival day through the whole of the day before departure"
-- and the times on it carried no information. New and edited bookings now carry
-- the real window (see lib/stayWindow.js), and these rows need the same shape or
-- the constraint would be comparing two different conventions.
--
-- 14:00 / 12:00 are the shipped defaults (HOTEL_DEFAULTS in the folio service's
-- lib/settings.js). They are deliberately hardcoded here: the configured values
-- live in the folio service's AppSetting table, which is a DIFFERENT database
-- that this migration cannot read. A property that has changed its times will
-- see them applied to new and edited bookings; these historical rows keep the
-- default stamp, which is correct enough for a window nobody will re-check.
--
-- ── WHY TWO STATEMENTS, IN THIS ORDER ───────────────────────────────────────
-- An exclusion constraint is checked per row as the statement runs, not at
-- commit. Consider a back-to-back pair in one room:
--
--   A = [Aug 30 00:00, Aug 31 00:00)      B = [Aug 31 00:00, Sep 01 00:00)
--
-- Moving A's checkOut to Aug 31 12:00 first would EXTEND A's range while B still
-- starts at Aug 31 00:00 — the two would overlap and the migration would abort.
--
-- Moving every checkIn first is always safe: pushing a start from 00:00 to 14:00
-- only ever SHRINKS a range. Once B starts at Aug 31 14:00, extending A's end to
-- Aug 31 12:00 cannot reach it, because check-out precedes check-in on the clock
-- (validateHotel refuses any other pair). So: all starts, then all ends.
UPDATE "Reservation"
   SET "checkIn" = date_trunc('day', "checkIn") + interval '14 hours'
 WHERE "checkIn" = date_trunc('day', "checkIn");

UPDATE "Reservation"
   SET "checkOut" = date_trunc('day', "checkOut") + interval '12 hours'
 WHERE "checkOut" = date_trunc('day', "checkOut");
