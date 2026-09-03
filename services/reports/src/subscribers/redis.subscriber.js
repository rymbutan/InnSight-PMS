// The reports service reads on demand from other services and does not consume
// cross-service events. No-op so index.js can call startSubscriber()/
// disconnect() uniformly — add channels here if reports needs to react later.
function startSubscriber() {
  return null;
}

module.exports = { startSubscriber };
