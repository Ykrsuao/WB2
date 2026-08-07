'use strict';

/**
 * workbuddy2api — expose Tencent WorkBuddy (CodeBuddy desktop) as a local
 * OpenAI-compatible REST API. Multi-account: each account runs its own
 * isolated agent-cli instance.
 *
 * Endpoints:
 *   GET  /v1/health               service + per-account CLI status
 *   GET  /v1/auth/status          account info (default account)
 *   GET  /v1/accounts             list accounts
 *   POST /v1/accounts             add/update account (admin key)
 *   DELETE /v1/accounts/:id       remove account (admin key)
 *   POST /v1/chat/completions     OpenAI-compatible (stream & non-stream)
 *   POST /v1/agent/runs           raw agent run (Gateway Protocol message)
 *   GET  /v1/agent/runs/:id/stream    raw SSE stream
 *   POST /v1/agent/runs/:id/cancel    cancel a run
 *   GET  /v1/sessions             list CLI sessions (default account)
 *   GET  /v1/openapi.json         the CLI gateway OpenAPI spec
 *   /cli/*                        full passthrough (default account)
 *
 * Account selection on requests: header `X-Account-Id` or body `account`
 * field; falls back to the first enabled account.
 *
 * Env (see README):
 *   WORKBUDDY2API_PORT / HOST / API_KEY / CLI_DIR / CLI_BIN / CWD
 *   WORKBUDDY2API_MODEL / EFFORT / CLI_ARGS / ENDPOINT
 *   WORKBUDDY2API_ACCOUNTS_FILE
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Minimal .env loader (zero-dependency): WORKBUDDY2API_* vars only.
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key.startsWith('WORKBUDDY2API_') && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
})();

const { AccountsRegistry } = require('./lib/accounts');
const { CliPool } = require('./lib/cli-pool');
const { LoadBalancer } = require('./lib/lb');
const { LoginManager } = require('./lib/login');
const { loadSession } = require('./lib/auth');
const { getConfig, applyPatch } = require('./lib/config');
const { getBilling } = require('./lib/billing');
const { getCheckinStatus, claimDailyCheckin, createCheckinScheduler, isCheckedIn } = require('./lib/checkin');
const {
  handleChatCompletions,
  handleAgentRun,
  handleAgentRunStream,
  gatewayRequest,
} = require('./lib/chat');
const { handleMessages, handleResponses } = require('./lib/anthropic');
const { readJsonBody, sendJson, sendError } = require('./lib/util');
const { modelsList, findModel, updateLive, isLiveFresh, refreshLiveFromCli, mergedModels } = require('./lib/models');

const PORT = Number(process.env.WORKBUDDY2API_PORT) || 8787;
const HOST = process.env.WORKBUDDY2API_HOST || '127.0.0.1';
const API_KEY = process.env.WORKBUDDY2API_API_KEY || '';
const ATTACH_PORT = Number(process.env.WORKBUDDY2API_ATTACH_PORT) || 0;

const accounts = new AccountsRegistry({
  file: process.env.WORKBUDDY2API_ACCOUNTS_FILE,
});
const lb = new LoadBalancer(accounts);
const pool = new CliPool({
  accounts,
  cliOptions: {
    attachPort: ATTACH_PORT,
    port: Number(process.env.WORKBUDDY2API_CLI_PORT) || 0,
    cwd: process.env.WORKBUDDY2API_CWD || process.cwd(),
    cliDir: process.env.WORKBUDDY2API_CLI_DIR,
    cliBin: process.env.WORKBUDDY2API_CLI_BIN,
    model: process.env.WORKBUDDY2API_MODEL || null,
    effort: process.env.WORKBUDDY2API_EFFORT || null,
    extraArgs: process.env.WORKBUDDY2API_CLI_ARGS || '',
  },
});
const loginManager = new LoginManager({ accounts, cliOptions: pool.cliOptions });

/** Known model id set (for Anthropic claude-* mapping). */
function knownModels() {
  return new Set(mergedModels().map((m) => m.id));
}

/** Resolve { token, userId } for an account (token + uid from session/JWT). */
async function resolveAccountAuth(account) {
  const { token } = await accounts.getAccessToken(account);
  let userId = null;
  if (account.source === 'desktop') {
    const sess = loadSession();
    userId = sess.ok ? sess.account.uid : null;
  } else if (token) {
    try {
      const p = token.split('.')[1];
      const b64 = p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4);
      userId = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).sub || null;
    } catch {
      userId = null;
    }
  }
  return { token, userId };
}

/** Bearer auth for the outer API. */
function authorized(req) {
  if (!API_KEY) return true;
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${API_KEY}`;
}

function sendUnauthorized(res) {
  sendError(res, 401, 'UNAUTHORIZED', 'missing or invalid API key');
}

// ---- daily check-in auto scheduler (每日自动签到) ----
const checkinScheduler = createCheckinScheduler({
  accounts,
  resolveAuth: resolveAccountAuth,
  endpoint: process.env.WORKBUDDY2API_ENDPOINT,
  enabled: process.env.WORKBUDDY2API_CHECKIN !== '0',
  onLog: (m) => console.log(m),
});
checkinScheduler.start();

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // The web panel shell is public (no data inside); all its data API calls
  // still require the API key via the Authorization header.
  if ((pathname === '/panel' || pathname === '/panel/') && method === 'GET') {
    const panelPath = path.join(__dirname, 'web', 'index.html');
    try {
      const html = fs.readFileSync(panelPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return sendError(res, 404, 'NOT_FOUND', 'panel not bundled');
    }
  }
  // Static vendor asset: pure-JS QR generator (panel renders the login QR
  // locally; no external image service involved).
  if (pathname === '/vendor/qrcode.js' && method === 'GET') {
    const qrPath = path.join(__dirname, 'web', 'qrcode.js');
    try {
      const js = fs.readFileSync(qrPath);
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(js);
    } catch {
      return sendError(res, 404, 'NOT_FOUND', 'qrcode.js not bundled');
    }
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (!authorized(req)) return sendUnauthorized(res);

  // OPTIONS preflight (CORS-friendly for local tools)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CodeBuddy-Request, X-Account-Id',
    });
    return res.end();
  }

  // ---- /v1/health ----
  if (pathname === '/v1/health' && method === 'GET') {
    const auth = loadSession();
    const cliAccounts = pool.status();
    return sendJson(res, 200, {
      ok: true, // service is up (pure LLM API; CLI instances optional)
      service: 'workbuddy2api',
      engine: 'direct',
      lb: lb.status(),
      cli: cliAccounts,
      accounts: accounts.list().length,
      auth: auth.ok ? { file: 'found', ok: true, account: auth.account, token: auth.token } : { file: 'missing', ok: false, error: auth.error },
    });
  }

  // ---- /v1/auth/status ----
  if (pathname === '/v1/auth/status' && method === 'GET') {
    const account = accounts.defaultAccount();
    if (account && account.source === 'desktop') {
      const auth = loadSession();
      if (!auth.ok) return sendJson(res, 200, { authenticated: false, error: auth.error });
      return sendJson(res, 200, { authenticated: !auth.token.expired, account: auth.account, token: auth.token, sessionFile: auth.sessionFile, accountId: account.id });
    }
    if (account) {
      const { token } = await accounts.getAccessToken(account);
      return sendJson(res, 200, { authenticated: !!token, accountId: account.id, name: account.name, source: account.source });
    }
    return sendJson(res, 200, { authenticated: false, error: 'no accounts configured' });
  }

  // ---- /v1/accounts ----
  if (pathname === '/v1/accounts' && method === 'GET') {
    return sendJson(res, 200, { accounts: accounts.list() });
  }
  if (pathname === '/v1/accounts' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, 400, 'BAD_REQUEST', e.message);
    }
    try {
      const acc = accounts.upsert(body);
      return sendJson(res, 200, { account: acc });
    } catch (e) {
      return sendError(res, 400, 'BAD_REQUEST', e.message);
    }
  }
  const dm = pathname.match(/^\/v1\/accounts\/([^/]+)$/);
  if (dm && method === 'DELETE') {
    const removed = accounts.remove(decodeURIComponent(dm[1]));
    if (!removed) return sendError(res, 404, 'NOT_FOUND', 'account not found');
    // stop its CLI if running
    const inst = pool.instances.get(dm[1]);
    if (inst) {
      await inst.stop();
      pool.instances.delete(dm[1]);
    }
    return sendJson(res, 200, { removed: true });
  }

  // ---- /v1/config (runtime settings, incl. system prompt) ----
  if (pathname === '/v1/config' && method === 'GET') {
    return sendJson(res, 200, getConfig({ lb: lb.status(), accounts: accounts.list().length }));
  }
  if (pathname === '/v1/config' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, 400, 'BAD_REQUEST', e.message);
    }
    const patch = {};
    if ('model' in body) patch.WORKBUDDY2API_MODEL = body.model;
    if ('effort' in body) patch.WORKBUDDY2API_EFFORT = body.effort;
    if ('lb' in body) patch.WORKBUDDY2API_LB = body.lb;
    if ('cliArgs' in body) patch.WORKBUDDY2API_CLI_ARGS = body.cliArgs;
    if (Object.keys(patch).length === 0) return sendError(res, 400, 'BAD_REQUEST', 'nothing to update');
    const { changed, needsCliRestart } = applyPatch(patch);
    if (needsCliRestart) await pool.restartAll();
    return sendJson(res, 200, { ok: true, changed, needsCliRestart });
  }

  // ---- /v1/auth/login (panel sign-in flow) ----
  if (pathname === '/v1/auth/login' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, 400, 'BAD_REQUEST', e.message);
    }
    try {
      const session = await loginManager.start({ method: body.method || 'internal', name: body.name || null });
      return sendJson(res, 200, session);
    } catch (e) {
      return sendError(res, 500, 'LOGIN_START_FAILED', e.message);
    }
  }
  const lm = pathname.match(/^\/v1\/auth\/login\/([^/]+)$/);
  if (lm && method === 'GET') {
    return sendJson(res, 200, loginManager.status(lm[1]));
  }

  // ---- /v1/billing (credits / 积分) ----
  if (pathname === '/v1/billing' && method === 'GET') {
    const requestedId = req.headers['x-account-id'] || url.searchParams.get('account');
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account');
    const { token, userId } = await resolveAccountAuth(account);
    try {
      const billing = await getBilling({
        endpoint: process.env.WORKBUDDY2API_ENDPOINT || 'https://copilot.tencent.com',
        token,
        userId,
        enterpriseId: account.enterpriseId || null,
      });
      return sendJson(res, 200, { accountId: account.id, ...billing });
    } catch (e) {
      return sendError(res, e.statusCode || 502, 'BILLING_FAILED', e.message);
    }
  }

  // ---- /v1/checkin (每日签到) ----
  if (pathname === '/v1/checkin' && method === 'GET') {
    const out = { auto: checkinScheduler.state(), accounts: [] };
    // resolve to live records (accounts.list() strips tokens)
    const list = accounts.list().map((a) => accounts.get(a.id) || a);
    for (const acc of list) {
      try {
        const { token, userId } = await resolveAccountAuth(acc);
        let status = null;
        if (token && userId) {
          const live = accounts.get(acc.id) || acc;
          status = await getCheckinStatus({
            endpoint: process.env.WORKBUDDY2API_ENDPOINT || 'https://copilot.tencent.com',
            token,
            userId,
            enterpriseId: live.enterpriseId || null,
            domain: live.domain || null,
          });
        }
        out.accounts.push({ accountId: acc.id, name: acc.name, source: acc.source, status });
      } catch (e) {
        out.accounts.push({ accountId: acc.id, name: acc.name, source: acc.source, error: e.message });
      }
    }
    return sendJson(res, 200, out);
  }
  if (pathname === '/v1/checkin' && method === 'POST') {
    await checkinScheduler.runNow();
    return sendJson(res, 200, checkinScheduler.state());
  }
  const cim = pathname.match(/^\/v1\/checkin\/([^/]+)$/);
  if (cim && method === 'POST') {
    const acc = accounts.get(decodeURIComponent(cim[1]));
    if (!acc) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', `no such account: ${cim[1]}`);
    const { token, userId } = await resolveAccountAuth(acc);
    if (!token || !userId) return sendError(res, 401, 'NO_TOKEN', 'account has no valid token');
    try {
      const live = accounts.get(acc.id) || acc;
      const status = await getCheckinStatus({
        endpoint: process.env.WORKBUDDY2API_ENDPOINT || 'https://copilot.tencent.com',
        token,
        userId,
        enterpriseId: live.enterpriseId || null,
        domain: live.domain || null,
      });
      const already = isCheckedIn(status);
      if (already) return sendJson(res, 200, { ok: true, already: true, status });
      const reward = await claimDailyCheckin({
        endpoint: process.env.WORKBUDDY2API_ENDPOINT || 'https://copilot.tencent.com',
        token,
        userId,
        enterpriseId: live.enterpriseId || null,
        domain: live.domain || null,
      });
      return sendJson(res, 200, { ok: true, already: false, reward, status });
    } catch (e) {
      return sendError(res, e.statusCode || 502, 'CHECKIN_FAILED', e.message);
    }
  }

  // ---- /v1/models ----
  if (pathname === '/v1/models' && method === 'GET') {
    const account = lb.pick(req.headers['x-account-id'] || url.searchParams.get('account'));
    // Only refresh live models from a CLI that is ALREADY running — never
    // spawn one just to list models (pure API: no CLI by default).
    if (account && !isLiveFresh()) {
      try {
        const { cli } = pool.getCliSync(account.id);
        if (cli && cli.state === 'ready') {
          await refreshLiveFromCli(cli.baseUrl, cli.cwd, account.id);
        }
      } catch {
        /* best-effort: static list still returned */
      }
    }
    return sendJson(res, 200, modelsList(account ? account.id : null));
  }
  const mm = pathname.match(/^\/v1\/models\/([^/]+)$/);
  if (mm && method === 'GET') {
    const model = findModel(decodeURIComponent(mm[1]));
    if (!model) return sendError(res, 404, 'MODEL_NOT_FOUND', `no such model: ${mm[1]}`);
    return sendJson(res, 200, model);
  }

  // ---- /v1/chat/completions ----
  if (pathname === '/v1/chat/completions' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e.statusCode || 400, 'BAD_REQUEST', e.message);
    }
    const requestedId = req.headers['x-account-id'] || body.account;
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account available');
    const { token, userId } = await resolveAccountAuth(account);
    return handleChatCompletions(null, req, res, body, {
      id: account.id,
      token,
      userId,
      endpoint: process.env.WORKBUDDY2API_ENDPOINT,
    });
  }

  // ---- /v1/messages (Anthropic-compatible, for Claude Code etc.) ----
  if (pathname === '/v1/messages' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e.statusCode || 400, 'BAD_REQUEST', e.message);
    }
    // request log: one-line summary by default; full body dump only when
    // WORKBUDDY2API_DEBUG=1 (helps diagnosing Claude Code interop issues)
    const dbg = process.env.WORKBUDDY2API_DEBUG;
    if (dbg !== '0') {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const roles = msgs.map((m) => `${m.role}:${Array.isArray(m.content) ? m.content.map((b) => b.type).join('+') : (typeof m.content === 'string' ? `str(${m.content.length})` : typeof m.content)}`).join(' | ');
      console.log(`[req] /v1/messages model=${body.model} max_tokens=${body.max_tokens} stream=${!!body.stream} thinking=${JSON.stringify(body.thinking)} tools=${Array.isArray(body.tools) ? body.tools.length : 0} sys=${typeof body.system === 'string' ? body.system.length : Array.isArray(body.system) ? body.system.map((b) => (b.text || '').length).reduce((a, b) => a + b, 0) : 0}`);
      console.log(`[req]   messages: ${roles}`);
      if (dbg === '1') {
        try {
          const fs = require('fs');
          const path = require('path');
          const dumpDir = path.join(__dirname, '_tools', 'req_dumps');
          fs.mkdirSync(dumpDir, { recursive: true });
          const fname = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
          fs.writeFileSync(path.join(dumpDir, fname), JSON.stringify(body, null, 2), 'utf8');
          console.log(`[req]   body dumped to _tools/req_dumps/${fname}`);
        } catch (e) {
          console.log('[req] dump error:', e.message);
        }
      }
    }
    const requestedId = req.headers['x-account-id'] || (body.metadata && body.metadata.account);
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account available');
    const { token, userId } = await resolveAccountAuth(account);
    return handleMessages(null, req, res, body, {
      id: account.id,
      token,
      userId,
      endpoint: process.env.WORKBUDDY2API_ENDPOINT,
      knownModels: knownModels(),
    });
  }

  // ---- /v1/responses (Anthropic Responses API, newer Claude Code) ----
  if (pathname === '/v1/responses' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e.statusCode || 400, 'BAD_REQUEST', e.message);
    }
    const requestedId = req.headers['x-account-id'] || (body.metadata && body.metadata.account);
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account available');
    const { token, userId } = await resolveAccountAuth(account);
    return handleResponses(null, req, res, body, {
      id: account.id,
      token,
      userId,
      endpoint: process.env.WORKBUDDY2API_ENDPOINT,
      knownModels: knownModels(),
    });
  }

  // ---- /v1/agent/runs ----
  if (pathname === '/v1/agent/runs' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e.statusCode || 400, 'BAD_REQUEST', e.message);
    }
    const requestedId = req.headers['x-account-id'] || body.account;
    const account = lb.pick(requestedId, body.sessionId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account');
    const { cli } = await pool.getCliFor(account);
    if (!cli || cli.state !== 'ready') return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
    return handleAgentRun(cli, req, res, body);
  }
  let m = pathname.match(/^\/v1\/agent\/runs\/([^/]+)\/stream$/);
  if (m && method === 'GET') {
    const requestedId = req.headers['x-account-id'];
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account');
    const { cli } = await pool.getCliFor(account);
    if (!cli || cli.state !== 'ready') return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
    return handleAgentRunStream(cli, req, res, m[1]);
  }
  m = pathname.match(/^\/v1\/agent\/runs\/([^/]+)\/cancel$/);
  if (m && method === 'POST') {
    const requestedId = req.headers['x-account-id'];
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account');
    const { cli } = await pool.getCliFor(account);
    if (!cli || !cli.baseUrl) return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
    try {
      const resp = await gatewayRequest(cli.baseUrl, 'POST', `/api/v1/runs/${m[1]}/cancel`);
      res.writeHead(resp.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(resp.text);
    } catch (e) {
      return sendError(res, 502, 'GATEWAY_ERROR', e.message);
    }
  }

  // ---- /v1/sessions ----
  if (pathname === '/v1/sessions' && method === 'GET') {
    const requestedId = req.headers['x-account-id'];
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account');
    const { cli } = await pool.getCliFor(account);
    if (!cli || !cli.baseUrl) return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
    try {
      const resp = await gatewayRequest(cli.baseUrl, 'GET', '/api/v1/sessions');
      res.writeHead(resp.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(resp.text);
    } catch (e) {
      return sendError(res, 502, 'GATEWAY_ERROR', e.message);
    }
  }

  // ---- /v1/openapi.json ----
  if (pathname === '/v1/openapi.json' && method === 'GET') {
    const specPath = path.join(__dirname, 'codebuddy-api-openapi.json');
    try {
      const spec = fs.readFileSync(specPath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(spec);
    } catch {
      return sendError(res, 404, 'NOT_FOUND', 'openapi spec not bundled');
    }
  }

  // ---- /cli/* full passthrough ----
  if (pathname.startsWith('/cli/')) {
    const requestedId = req.headers['x-account-id'];
    const account = lb.pick(requestedId);
    if (!account) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'no enabled account');
    const { cli } = await pool.getCliFor(account);
    if (!cli || !cli.baseUrl) return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
    const upstreamPath = pathname.slice(4); // drop /cli
    try {
      const resp = await gatewayRequest(cli.baseUrl, method, upstreamPath + url.search);
      res.writeHead(resp.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(resp.text);
    } catch (e) {
      return sendError(res, 502, 'GATEWAY_ERROR', e.message);
    }
  }

  return sendError(res, 404, 'NOT_FOUND', `no route for ${method} ${pathname}`);
}

const server = http.createServer(handleRequest);

async function main() {
  // No CLI warm-up: chat/completions & /v1/messages run on the direct LLM
  // engine (no agent-cli process). The CLI is only spawned lazily when
  // /v1/agent/runs or /cli/* are used.
  console.log('[svc] accounts:', accounts.list().map((a) => `${a.id}(${a.source})`).join(', '));

  server.listen(PORT, HOST, () => {
    console.log(`\nworkbuddy2api listening on http://${HOST}:${PORT}`);
    console.log(`  POST /v1/chat/completions   OpenAI-compatible chat`);
    console.log(`  GET  /v1/accounts           list accounts`);
    console.log(`  GET  /v1/health             status`);
    if (API_KEY) console.log('  API key required (Authorization: Bearer <key>)');
  });
}

process.on('SIGINT', async () => {
  console.log('\n[svc] shutting down...');
  await pool.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on('SIGTERM', async () => {
  await pool.stopAll();
  server.close(() => process.exit(0));
});

main().catch((e) => {
  console.error('[svc] fatal:', e);
  process.exit(1);
});
