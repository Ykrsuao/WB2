'use strict';

/**
 * Login flow — let users sign in through the web panel instead of pasting
 * refresh tokens.
 *
 * Flow:
 *   1. start({method, name})  spawns a short-lived, unauthenticated agent-cli
 *      in an isolated HOME, calls ACP `authenticate`, and returns the login
 *      URL the user must open (or scan as QR).
 *   2. status(loginId)        polls the isolated HOME for the session file
 *      the CLI writes once OAuth completes; when found, it extracts the
 *      refresh token and registers the account automatically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { CliManager } = require('./cli-manager');
const { AcpConnection } = require('./acp');
const { uuid } = require('./util');
const http = require('http');

/**
 * POST authenticate and resolve with the authUrl as soon as the
 * `_codebuddy.ai/authUrl` notification is seen in the SSE stream.
 */
function authenticateStream(conn, method) {
  const id = conn.nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'authenticate', params: { methodId: method } });
  return new Promise((resolve, reject) => {
    const req = http.request(conn.baseUrl + '/api/v1/acp', {
      method: 'POST',
      headers: {
        'X-CodeBuddy-Request': '1',
        'Content-Type': 'application/json',
        'Acp-Connection-Id': conn.connectionId,
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let data = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const msg = JSON.parse(data);
            if (msg && msg.method === '_codebuddy.ai/authUrl' && msg.params && msg.params.authUrl) {
              res.destroy();
              resolve(msg.params.authUrl);
              return;
            }
            // id-matched result with userinfo means already-authenticated
            if (msg && msg.id === id && msg.result) {
              res.destroy();
              reject(new Error('login CLI is already authenticated; isolation failed'));
              return;
            }
          } catch {
            /* ignore partial frames */
          }
        }
      };
      res.on('data', onData);
      res.on('error', (e) => reject(e));
      res.on('close', () => {
        // stream closed without authUrl -> likely failure
        reject(new Error('authenticate stream closed before authUrl'));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('authenticate timeout'));
    });
    req.write(body);
    req.end();
  });
}

const LOGIN_TTL_MS = 10 * 60 * 1000;

function accountsHome() {
  return (
    process.env.WORKBUDDY2API_ACCOUNTS_HOME ||
    path.join(os.tmpdir(), 'workbuddy2api', 'accounts')
  );
}

function isolatedEnv(home) {
  if (process.platform === 'win32') {
    return {
      USERPROFILE: home,
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      HOMEDRIVE: home.slice(0, 2),
      HOMEPATH: home.slice(2),
    };
  }
  return { HOME: home };
}

function sessionFileCandidates(home) {
  const bases =
    process.platform === 'win32'
      ? [path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
      : [path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'), path.join(home, '.codebuddy')];
  const out = [];
  for (const base of bases) {
    try {
      for (const f of fs.readdirSync(base)) {
        if (f.endsWith('.info')) out.push(path.join(base, f));
      }
    } catch {
      /* not yet */
    }
  }
  return out;
}

class LoginManager {
  constructor({ accounts, cliOptions }) {
    this.accounts = accounts;
    this.cliOptions = cliOptions;
    this.sessions = new Map(); // loginId -> { cli, home, method, name, startedAt, accountId }
  }

  async start({ method = 'internal', name = null }) {
    const loginId = uuid().slice(0, 8);
    const home = path.join(accountsHome(), `login-${loginId}`);
    fs.mkdirSync(home, { recursive: true });

    const cli = new CliManager({
      ...this.cliOptions,
      envOverrides: isolatedEnv(home),
      tokenProvider: () => Promise.resolve(null), // unauthenticated on purpose
    });
    const ok = await cli.start().catch((e) => false);
    if (!ok || cli.state !== 'ready') {
      await cli.stop().catch(() => {});
      throw new Error('failed to start login CLI');
    }

    // ACP authenticate -> capture _codebuddy.ai/authUrl notification.
    // NOTE: on an unauthenticated CLI the authenticate response stays OPEN
    // until the user finishes logging in, so we stream-read it and resolve
    // as soon as the authUrl notification arrives.
    const conn = new AcpConnection(cli.baseUrl);
    await conn.open();
    await conn.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const authUrl = await authenticateStream(conn, method);
    conn.close();

    this.sessions.set(loginId, { cli, home, method, name, startedAt: Date.now(), accountId: null });
    console.log(`[login] ${loginId} started (method=${method}, home=${home})`);
    return { loginId, authUrl, method, name: name || loginId };
  }

  /** Poll status; auto-registers the account when the session file appears. */
  status(loginId) {
    const s = this.sessions.get(loginId);
    if (!s) return { status: 'unknown' };
    if (s.accountId) return { status: 'authenticated', accountId: s.accountId, home: s.home };
    if (Date.now() - s.startedAt > LOGIN_TTL_MS) {
      this.cleanup(loginId);
      return { status: 'expired' };
    }
    // look for the session file the CLI writes after OAuth completes
    const files = sessionFileCandidates(s.home);
    if (files.length === 0) return { status: 'pending', authUrl: null };
    // newest file should contain the fresh session
    const newest = files
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
    try {
      const raw = JSON.parse(fs.readFileSync(newest, 'utf8'));
      if (!raw.auth || !raw.auth.refreshToken) return { status: 'pending' };
      const accountId = s.name || `acct-${loginId}`;
      const account = this.accounts.upsert({
        id: accountId,
        name: raw.account && (raw.account.nickname || raw.account.uid) || accountId,
        source: 'manual',
        refreshToken: raw.auth.refreshToken,
        home: s.home,
      });
      s.accountId = account.id;
      console.log(`[login] ${loginId} authenticated -> account '${account.id}'`);
      this.cleanup(loginId);
      return { status: 'authenticated', accountId: account.id, home: s.home };
    } catch {
      return { status: 'pending' };
    }
  }

  cleanup(loginId) {
    const s = this.sessions.get(loginId);
    if (!s) return;
    s.cli.stop().catch(() => {});
    this.sessions.delete(loginId);
  }

  list() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      loginId: id,
      method: s.method,
      name: s.name,
      status: s.accountId ? 'authenticated' : Date.now() - s.startedAt > LOGIN_TTL_MS ? 'expired' : 'pending',
      accountId: s.accountId || null,
    }));
  }
}

module.exports = { LoginManager, accountsHome, isolatedEnv };
