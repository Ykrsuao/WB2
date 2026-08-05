'use strict';

/**
 * Account registry — multi-account support.
 *
 * Each account maps to one isolated agent-cli instance, authenticated with
 * its own token (injected via CODEBUDDY_AUTH_TOKEN). Accounts are persisted
 * in accounts.json next to the service.
 *
 * Token lifecycle:
 *   - source: "desktop"  -> token is read live from the WorkBuddy desktop
 *     session file (only relevant on a machine with the desktop app).
 *   - source: "manual"   -> user supplies a refreshToken (obtained once via
 *     `codebuddy` interactive login on the server, or extracted from a
 *     session .info file). The service refreshes it via the CodeBuddy auth
 *     API and injects the access token into the account's CLI.
 */

const fs = require('fs');
const path = require('path');
const http = require('https');
const { loadSession } = require('./auth');

const DEFAULT_ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

class AccountsRegistry {
  constructor({ file = DEFAULT_ACCOUNTS_FILE, endpoint = null } = {}) {
    this.file = file;
    this.endpoint = endpoint || process.env.WORKBUDDY2API_ENDPOINT || 'https://copilot.tencent.com';
    this.accounts = [];
    this.byId = new Map();
    this.refreshInFlight = new Map(); // accountId -> Promise (dedupe concurrent refreshes)
    this._load();
  }

  _load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      /* first run */
    }
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.accounts)) this.accounts = data.accounts;
      } catch (e) {
        console.error('[accounts] failed to parse accounts.json:', e.message);
      }
    }
    // ensure a default "main" account pointing at the desktop session
    if (this.accounts.length === 0) {
      this.accounts.push({ id: 'main', name: 'WorkBuddy 主账号', source: 'desktop', enabled: true });
    }
    this._rebuildIndex();
  }

  _rebuildIndex() {
    this.byId = new Map(this.accounts.map((a) => [a.id, a]));
  }

  _save() {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts: this.accounts }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Public view of an account (never leaks tokens). */
  _public(account) {
    const { refreshToken, accessToken, expiresAt, refreshExpiresAt, ...pub } = account;
    return {
      ...pub,
      hasToken: !!(refreshToken || accessToken),
      expiresAt: expiresAt || null,
      refreshExpiresAt: refreshExpiresAt || null,
    };
  }

  list() {
    return this.accounts.map((a) => this._public(a));
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Public view by id. */
  getPublic(id) {
    const a = this.get(id);
    return a ? this._public(a) : null;
  }

  /** First enabled account (default routing target). */
  defaultAccount() {
    return this.accounts.find((a) => a.enabled) || this.accounts[0] || null;
  }

  /**
   * Resolve an account id from a request (header X-Account-Id or body
   * `account` field). Falls back to the default account.
   */
  resolve(requestedId) {
    if (requestedId) {
      const acc = this.get(requestedId);
      if (acc && acc.enabled) return acc;
    }
    return this.defaultAccount();
  }

  /** Add or replace an account. */
  upsert(account) {
    if (!account || !account.id) throw new Error('account.id is required');
    const idx = this.accounts.findIndex((a) => a.id === account.id);
    const clean = { id: account.id, name: account.name || account.id, source: account.source || 'manual', enabled: account.enabled !== false };
    if (account.source === 'manual') {
      if (!account.refreshToken) throw new Error('manual account requires refreshToken');
      clean.refreshToken = account.refreshToken;
      clean.refreshExpiresAt = account.refreshExpiresAt || null;
    }
    if (idx >= 0) this.accounts[idx] = { ...this.accounts[idx], ...clean };
    else this.accounts.push(clean);
    this._rebuildIndex();
    this._save();
    return this._public(clean);
  }

  remove(id) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length === before) return false;
    this._rebuildIndex();
    this._save();
    return true;
  }

  /**
   * Resolve the current access token for an account (and a flag whether the
   * token may need refreshing later).
   */
  async getAccessToken(account) {
    if (!account) return { token: null };
    if (account.source === 'desktop') {
      const sess = loadSession();
      if (sess.ok && sess.token && !sess.token.expired) {
        // re-read the raw session for the access token
        try {
          const raw = JSON.parse(fs.readFileSync(sess.sessionFile, 'utf8'));
          if (raw.auth && raw.auth.accessToken) return { token: raw.auth.accessToken, from: 'desktop' };
        } catch {
          /* fall through */
        }
        return { token: null, from: 'desktop' };
      }
      return { token: null, from: 'desktop' };
    }
    if (account.accessToken && (!account.expiresAt || account.expiresAt > Date.now() + 60000)) {
      return { token: account.accessToken, from: 'cached' };
    }
    // refresh, deduped per account (Keycloak rotates refresh tokens; concurrent
    // refreshes would invalidate each other)
    if (!this.refreshInFlight.has(account.id)) {
      const p = this.refresh(account).finally(() => this.refreshInFlight.delete(account.id));
      this.refreshInFlight.set(account.id, p);
    }
    const refreshed = await this.refreshInFlight.get(account.id);
    if (!refreshed) return { token: account.accessToken || null, from: 'stale' };
    return { token: refreshed.accessToken, from: 'refreshed' };
  }

  /**
   * Refresh a manual account's token via the CodeBuddy auth API.
   * POST {endpoint}/v2/plugin/auth/token/refresh with X-Refresh-Token.
   * Returns { accessToken, refreshToken?, expiresIn? } or null on failure.
   */
  refresh(account) {
    if (!account || !account.refreshToken) return Promise.resolve(null);
    const payload = JSON.stringify({});
    return new Promise((resolve) => {
      const url = new URL(this.endpoint + REFRESH_PATH);
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Refresh-Token': account.refreshToken,
            'X-Auth-Refresh-Source': 'plugin',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              /* not json */
            }
            const data = parsed && parsed.data;
            if (res.statusCode === 200 && data && data.accessToken) {
              account.accessToken = data.accessToken;
              account.expiresAt = data.expiresAt || Date.now() + (data.expiresIn || 0) * 1000 || null;
              if (data.refreshToken) {
                account.refreshToken = data.refreshToken;
                account.refreshExpiresAt = data.refreshExpiresAt || account.refreshExpiresAt;
              }
              this._save();
              resolve({ accessToken: data.accessToken, refreshToken: data.refreshToken || account.refreshToken, expiresIn: data.expiresIn });
            } else {
              console.warn(`[accounts] refresh failed for ${account.id}: HTTP ${res.statusCode}`, (parsed && parsed.msg) || '');
              resolve(null);
            }
          });
          res.on('error', () => resolve(null));
        }
      );
      req.on('error', (e) => {
        console.warn(`[accounts] refresh request error for ${account.id}: ${e.message}`);
        resolve(null);
      });
      req.setTimeout(20000, () => {
        req.destroy();
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { AccountsRegistry, DEFAULT_ACCOUNTS_FILE };
