// The auth service publishes events (auth:login, auth:user_*, …) but does not
// currently consume any. This is a no-op so index.js can call
// startSubscriber()/disconnect() uniformly — add channels here if auth ever
// needs to react to cross-service events.
function startSubscriber() {
  return null;
}

module.exports = { startSubscriber };
