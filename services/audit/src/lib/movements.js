// Counts a movements response from the stay service.
//
// /api/arrivals returns { range, degraded, arrivals } and /api/departures still
// returns a bare array. Reading `.length` off the arrivals envelope yielded
// undefined, which the audit then recorded as the day's arrival count -- a wrong
// number written into a financial record with nothing reporting it.
function movementCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.arrivals)) return payload.arrivals.length;
  return 0;
}

module.exports = { movementCount };
