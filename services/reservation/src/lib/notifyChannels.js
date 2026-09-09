// Mocked SMS/Viber delivery, alongside the real (Mailhog-backed) email in
// lib/notifier.js.
//
// WHY MOCKED
// ----------
// There is no real SMS or Viber provider anywhere in this stack, and
// docker-compose.yml's "RUNNING OFFLINE" note is explicit: the only external
// request this app is allowed to make is Google Sign-In. A live SMS/Viber API
// (Twilio, Semaphore, the Viber Business API) needs real credentials and a
// real outbound call, which breaks that constraint outright. This logs to the
// database instead — the same role Mailhog plays for email: an operator can
// see exactly what would have gone out and to whom, with nothing actually
// leaving the building.
//
// PURE-ish: takes `prisma` as an argument rather than requiring lib/prisma.js
// itself, so a caller that already has a client (or a test double) can pass
// its own instead of this module constructing a second connection pool.

async function logNotification(prisma, { reservationId, channel, to, subject, body, status = 'SENT', error }) {
  try {
    await prisma.notificationLog.create({
      data: { reservationId, channel, to, subject, body, status, error },
    });
  } catch (e) {
    // Never blocks a confirmation over its own audit trail failing to write.
    console.error('[Reservation] Could not persist notification log:', e.message);
  }
}

// SMS and Viber share one compact, no-subject-line body — a real gateway for
// either charges per segment, so the templates below are deliberately short
// rather than the multi-paragraph email.
async function sendSms(prisma, reservation, body) {
  if (!reservation?.guestPhone) return;
  console.log(`[Reservation] (mock SMS) to ${reservation.guestPhone}: ${body}`);
  await logNotification(prisma, {
    reservationId: reservation.id,
    channel: 'SMS',
    to: reservation.guestPhone,
    body,
  });
}

async function sendViber(prisma, reservation, body) {
  if (!reservation?.guestPhone) return;
  console.log(`[Reservation] (mock Viber) to ${reservation.guestPhone}: ${body}`);
  await logNotification(prisma, {
    reservationId: reservation.id,
    channel: 'VIBER',
    to: reservation.guestPhone,
    body,
  });
}

// Short SMS/Viber bodies for the same events lib/notifier.js's TEMPLATES
// covers by email. Kept in lockstep with those templates' content (not their
// exact wording — a text message is not a shortened email) so both channels
// agree on what happened and when.
const SMS_TEMPLATES = {
  reservation_confirmed: (r) =>
    `InnSight Hotel: booking ${r.confirmationNumber} confirmed for ` +
    `${new Date(r.checkIn).toDateString()}–${new Date(r.checkOut).toDateString()}. See you soon!`,
  reservation_cancelled: (r) => `InnSight Hotel: booking ${r.confirmationNumber} has been cancelled.`,
};

module.exports = { sendSms, sendViber, logNotification, SMS_TEMPLATES };
