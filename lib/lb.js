'use strict';

/**
 * Load balancer — picks an account for requests that don't specify one.
 *
 * Strategies (env WORKBUDDY2API_LB):
 *   first          (default) always the first enabled account
 *   round-robin    cycle through enabled accounts
 *   least-loaded   pick the account with the fewest in-flight requests
 */

/** Read the active strategy from env (dynamic — panel changes apply live). */
function currentStrategy() {
  return (process.env.WORKBUDDY2API_LB || 'first').toLowerCase();
}

class LoadBalancer {
  constructor(accounts) {
    this.accounts = accounts;
    this.rrIndex = 0;
    this.inFlight = new Map(); // accountId -> active request count
    this.sessionOwner = new Map(); // sessionId -> { accountId, ts } (stickiness)
    this.SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
  }

  /** Record which account owns a session id (for multi-turn stickiness). */
  setSessionOwner(sessionId, accountId) {
    if (!sessionId || !accountId) return;
    this.sessionOwner.set(sessionId, { accountId, ts: Date.now() });
  }

  /** Owner account for a session id, if any (and still valid). */
  sessionAccountId(sessionId) {
    if (!sessionId) return null;
    const rec = this.sessionOwner.get(sessionId);
    if (!rec) return null;
    if (Date.now() - rec.ts > this.SESSION_TTL_MS) {
      this.sessionOwner.delete(sessionId);
      return null;
    }
    return rec.accountId;
  }

  /** Sweep stale owner records (called on each pick, cheap). */
  _sweep() {
    if (this.sessionOwner.size < 200) return;
    const cutoff = Date.now() - this.SESSION_TTL_MS;
    for (const [k, v] of this.sessionOwner) {
      if (v.ts < cutoff) this.sessionOwner.delete(k);
    }
  }

  get strategy() {
    return currentStrategy();
  }

  /** Active request count for an account id. */
  inflight(id) {
    return this.inFlight.get(id) || 0;
  }

  _enabled() {
    return this.accounts.list().filter((a) => a.enabled);
  }

  /**
   * Pick the account for a request.
   * NOTE: always returns the LIVE account record (accounts.list() returns
   * token-stripped clones, which would break token resolution downstream).
   * @param {string|null} requestedId explicit X-Account-Id / body account
   * @param {string|null} sessionId   existing conversation session id (stickiness)
   * @returns {object|null} account record
   */
  pick(requestedId, sessionId) {
    this._sweep();
    const enabled = this._enabled();
    if (enabled.length === 0) return null;
    const live = (acc) => this.accounts.get(acc.id) || acc;

    if (requestedId) {
      const acc = this.accounts.get(requestedId);
      if (acc && acc.enabled) return acc;
      return null; // explicit but unknown/disabled -> treat as error upstream
    }

    // session stickiness: multi-turn must stay on the account that owns it
    if (sessionId) {
      const ownerId = this.sessionAccountId(sessionId);
      if (ownerId) {
        const owner = this.accounts.get(ownerId);
        if (owner && owner.enabled) return owner;
      }
    }

    switch (currentStrategy()) {
      case 'round-robin': {
        const acc = enabled[this.rrIndex % enabled.length];
        this.rrIndex += 1;
        return live(acc);
      }
      case 'least-loaded': {
        let best = null;
        for (const a of enabled) {
          if (!best || this.inflight(a.id) < this.inflight(best.id)) best = a;
        }
        return live(best);
      }
      default:
        return live(enabled[0]);
    }
  }

  /** Mark a request started for an account; returns a release() fn. */
  begin(accountId) {
    this.inFlight.set(accountId, (this.inFlight.get(accountId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(accountId, Math.max(0, (this.inFlight.get(accountId) || 1) - 1));
    };
  }

  status() {
    return {
      strategy: currentStrategy(),
      inflight: Object.fromEntries(this.inFlight),
    };
  }
}

module.exports = { LoadBalancer };
