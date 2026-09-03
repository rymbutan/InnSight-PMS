// The audit service drives night-audit steps by calling other services
// directly and publishes audit:* events; it does not currently consume any.
// No-op so index.js can call startSubscriber()/disconnect() uniformly.
function startSubscriber() {
  return null;
}

module.exports = { startSubscriber };
