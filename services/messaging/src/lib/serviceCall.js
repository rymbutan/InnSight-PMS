// Authenticated service-to-service HTTP with a MANDATORY timeout.
//
// WHY THIS EXISTS
// ---------------
// Node's global fetch() has no default timeout. Every inter-service call in this
// codebase was written as a bare `await fetch(url)`, so a single wedged service
// stalls its callers indefinitely — and now that reservation creation calls
// inventory synchronously on the critical path, an unbounded wait there would
// hang every booking in the hotel rather than failing one request.
//
// Every caller built here gets an AbortSignal, a bounded retry policy, and a
// typed error carrying the upstream status code so callers can map 409 → 409
// instead of collapsing everything into a 500.

const { signServiceToken } = require('../middleware/auth');

const DEFAULT_TIMEOUT_MS = 5000;

// Retrying a non-idempotent POST would risk duplicating the side effect, so only
// GET is retried by default. Callers that pass an Idempotency-Key can opt in.
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);

class ServiceCallError extends Error {
  constructor(message, { statusCode, url, body, cause } = {}) {
    super(message);
    this.name = 'ServiceCallError';
    this.statusCode = statusCode;
    this.url = url;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a caller that signs each request with a short-lived service token.
 *
 * @param {object}   cfg
 * @param {string}   cfg.name         e.g. 'reservation' → sub 'system.reservation'
 * @param {string[]} cfg.roles        roles to assert (keep as narrow as possible)
 * @param {string[]} cfg.permissions
 * @param {string}   cfg.secret       JWT_SECRET from the service's auth middleware
 * @param {number}  [cfg.timeoutMs]
 * @param {number}  [cfg.retries]     retry attempts for retryable methods
 */
function makeServiceCaller({
  name,
  roles = [],
  permissions = [],
  secret,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = 2,
}) {
  // `secret` is accepted for backwards compatibility with existing callers but is
  // no longer used to sign: machine tokens are signed by the ONE shared minter in
  // middleware/auth.js, with the separate SERVICE_JWT_SECRET and the pinned
  // issuer/audience that verifyToken now requires. Signing here independently would
  // produce tokens every service rejects.
  void secret;

  function serviceToken() {
    return signServiceToken({ name, roles, permissions, expiresIn: '2m' });
  }

  /**
   * @returns {Promise<any>} parsed JSON body
   * @throws  {ServiceCallError} on timeout, transport failure, or non-2xx
   */
  async function call(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const maxAttempts = RETRYABLE_METHODS.has(method) || options.retryUnsafe ? retries + 1 : 1;
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // AbortSignal.timeout() rejects the fetch itself, so a hung upstream can
      // never outlive the budget.
      const signal = AbortSignal.timeout(options.timeoutMs || timeoutMs);
      try {
        const res = await fetch(url, {
          ...options,
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceToken()}`,
            ...(options.headers || {}),
          },
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text.slice(0, 500);
          }
          const err = new ServiceCallError(`${method} ${url} → ${res.status}`, {
            statusCode: res.status,
            url,
            body,
          });
          // 4xx is a definitive answer from a healthy service — never retry it.
          // 5xx and 429 may be transient.
          if (res.status < 500 && res.status !== 429) throw err;
          lastErr = err;
        } else {
          // 204 and empty bodies are valid successes.
          const text = await res.text();
          if (!text) return null;
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        }
      } catch (err) {
        if (
          err instanceof ServiceCallError &&
          err.statusCode &&
          err.statusCode < 500 &&
          err.statusCode !== 429
        ) {
          throw err;
        }
        lastErr =
          err.name === 'TimeoutError' || err.name === 'AbortError'
            ? new ServiceCallError(`${method} ${url} timed out after ${options.timeoutMs || timeoutMs}ms`, {
                url,
                cause: err,
              })
            : err instanceof ServiceCallError
              ? err
              : new ServiceCallError(`${method} ${url} failed: ${err.message}`, { url, cause: err });
      }

      if (attempt < maxAttempts) {
        // Exponential backoff with jitter so simultaneous callers don't retry in lockstep.
        await sleep(Math.round(100 * 2 ** (attempt - 1) * (0.5 + Math.random())));
      }
    }
    throw lastErr;
  }

  return { call, serviceToken };
}

module.exports = { makeServiceCaller, ServiceCallError, DEFAULT_TIMEOUT_MS };
