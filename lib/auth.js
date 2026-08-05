'use strict';

/**
 * Reads the WorkBuddy desktop auth session file so the API can report
 * who is logged in and when the token expires.
 *
 * The agent-cli (spawned by this service) performs the actual LLM auth
 * itself using the very same file — we only mirror the info for /v1/auth/status.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Default session file used by WorkBuddy desktop + its bundled agent-cli. */
function defaultSessionPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const authId = process.env.WORKBUDDY_AUTH_ID || 'workbuddy-desktop';
  return path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', `${authId}.info`);
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function loadSession(sessionPath = null) {
  const file = sessionPath || defaultSessionPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: `auth session file not found: ${file}` };
  }
  try {
    const session = JSON.parse(raw);
    const account = session.account || {};
    const auth = session.auth || {};
    const now = Date.now();
    const payload = decodeJwtPayload(auth.accessToken);
    const expiresAt = auth.expiresAt || (payload && payload.exp ? payload.exp * 1000 : null);
    const refreshExpiresAt = auth.refreshExpiresAt || null;
    return {
      ok: true,
      sessionFile: file,
      account: {
        uid: account.uid || null,
        nickname: account.nickname || null,
        uin: account.uin || null,
        phoneNumber: account.phoneNumber || null,
        type: account.type || null,
        enterpriseId: account.enterpriseId || null,
      },
      token: {
        domain: auth.domain || null,
        expiresAt: expiresAt || null,
        refreshExpiresAt: refreshExpiresAt || null,
        expired: expiresAt !== null && expiresAt <= now,
        refreshExpired: refreshExpiresAt !== null && refreshExpiresAt <= now,
        secondsUntilExpiry: expiresAt !== null ? Math.floor((expiresAt - now) / 1000) : null,
      },
    };
  } catch (e) {
    return { ok: false, error: `failed to parse auth session file: ${e.message}` };
  }
}

module.exports = { loadSession, decodeJwtPayload, defaultSessionPath };
