'use strict';

/**
 * Daily check-in (每日签到).
 *
 * Reverse-engineered from the WorkBuddy desktop app
 * (workbuddy-auth-product-coordinator.js):
 *   GET  status : POST {endpoint}/v2/billing/meter/checkin-activity-status
 *   claim daily: POST {endpoint}/v2/billing/meter/daily-checkin
 * Headers: Authorization: Bearer <accessToken>, X-User-Id: <uid>
 *          (+ X-Enterprise-Id / X-Tenant-Id / X-Domain when present)
 * Success: HTTP 200 && body.code === 0 && body.data.
 *
 * Auto-scheduler: checks every interval; each account is claimed at most
 * once per calendar day (tracked in memory by YYYY-MM-DD), so a restart
 * mid-day simply claims the missing one. Manual trigger available via API.
 */

const https = require('https');
const http = require('http');

function jsonPost(endpoint, path, token, userId, headers = {}) {
  const url = new URL(endpoint.replace(/\/+$/, '') + path);
  const payload = '{}';
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'X-User-Id': userId,
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, json: parsed, text });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('checkin timeout')));
    req.write(payload);
    req.end();
  });
}

/** Query the check-in activity status for one account. */
async function getCheckinStatus({ endpoint, token, userId, enterpriseId, domain }) {
  const h = {};
  if (enterpriseId) {
    h['X-Enterprise-Id'] = enterpriseId;
    h['X-Tenant-Id'] = enterpriseId;
  }
  if (domain) h['X-Domain'] = domain;
  const resp = await jsonPost(endpoint, '/v2/billing/meter/checkin-activity-status', token, userId, h);
  if (resp.status !== 200 || !resp.json || resp.json.code !== 0) {
    const err = new Error(`checkin status failed (HTTP ${resp.status}): ${(resp.json && (resp.json.msg || resp.json.message)) || resp.text.slice(0, 200)}`);
    err.statusCode = resp.status;
    throw err;
  }
  return resp.json.data;
}

/** Claim the daily check-in for one account. Returns the reward payload. */
async function claimDailyCheckin({ endpoint, token, userId, enterpriseId, domain }) {
  const h = {};
  if (enterpriseId) {
    h['X-Enterprise-Id'] = enterpriseId;
    h['X-Tenant-Id'] = enterpriseId;
  }
  if (domain) h['X-Domain'] = domain;
  const resp = await jsonPost(endpoint, '/v2/billing/meter/daily-checkin', token, userId, h);
  if (resp.status !== 200 || !resp.json || resp.json.code !== 0) {
    const err = new Error(`daily checkin failed (HTTP ${resp.status}): ${(resp.json && (resp.json.msg || resp.json.message)) || resp.text.slice(0, 200)}`);
    err.statusCode = resp.status;
    err.body = resp.json;
    throw err;
  }
  return resp.json.data;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** True if the activity-status payload says today's check-in is already done. */
function isCheckedIn(status) {
  if (!status) return false;
  return (
    status.today_checked_in === true ||
    status.checkedIn === true ||
    status.isCheckedIn === true ||
    status.hasCheckedIn === true ||
    (status.today && status.today.checked === true) ||
    (typeof status.checked_in_today === 'boolean' && status.checked_in_today)
  );
}

/**
 * Auto check-in scheduler.
 * @param {object} opts {
 *   accounts   AccountsRegistry,
 *   resolveAuth async (account) => { token, userId },
 *   endpoint   string backend base url,
 *   intervalMs number (default 30 min),
 *   enabled    boolean (default true),
 *   onLog      (msg) => void
 * }
 */
function createCheckinScheduler(opts) {
  const {
    accounts,
    resolveAuth,
    endpoint = process.env.WORKBUDDY2API_ENDPOINT || 'https://copilot.tencent.com',
    intervalMs = 30 * 60 * 1000,
    enabled = true,
    onLog = () => {},
  } = opts;

  const done = new Map(); // accountId -> todayKey claimed
  const results = new Map(); // accountId -> last claim result

  async function runOnce() {
    const today = todayKey();
    // accounts.list() returns token-stripped public clones; resolve to the
    // live records so manual accounts keep their refreshToken.
    const list = accounts.list().map((a) => accounts.get(a.id) || a);
    for (const acc of list) {
      if (acc.enabled === false) continue;
      if (done.get(acc.id) === today) continue;
      try {
        const { token, userId } = await resolveAuth(acc);
        if (!token || !userId) {
          results.set(acc.id, { date: today, ok: false, error: 'NO_TOKEN' });
          onLog(`[checkin] ${acc.id} 无有效 token（NO_TOKEN）`);
          continue;
        }
        const status = await getCheckinStatus({
          endpoint,
          token,
          userId,
          enterpriseId: acc.enterpriseId || null,
          domain: acc.domain || null,
        });
        const already = isCheckedIn(status);
        if (already) {
          done.set(acc.id, today);
          results.set(acc.id, { date: today, ok: true, already: true, status });
          onLog(`[checkin] ${acc.id} 今日已签到（跳过）`);
          continue;
        }
        const reward = await claimDailyCheckin({
          endpoint,
          token,
          userId,
          enterpriseId: acc.enterpriseId || null,
          domain: acc.domain || null,
        });
        done.set(acc.id, today);
        results.set(acc.id, { date: today, ok: true, already: false, reward, status });
        onLog(`[checkin] ${acc.id} 签到成功: ${JSON.stringify(reward).slice(0, 200)}`);
      } catch (e) {
        results.set(acc.id, { date: today, ok: false, error: e.message });
        onLog(`[checkin] ${acc.id} 签到失败: ${e.message}`);
      }
    }
  }

  let timer = null;
  return {
    start() {
      if (!enabled) return;
      runOnce(); // catch up immediately (e.g. after restart)
      timer = setInterval(runOnce, intervalMs);
      if (timer.unref) timer.unref();
      onLog(`[checkin] 自动签到已开启（每 ${Math.round(intervalMs / 60000)} 分钟检查一次）`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runNow: runOnce,
    state() {
      return {
        enabled,
        today: todayKey(),
        results: [...results.entries()].map(([id, r]) => ({ accountId: id, ...r })),
      };
    },
  };
}

module.exports = { getCheckinStatus, claimDailyCheckin, createCheckinScheduler, isCheckedIn, todayKey };
