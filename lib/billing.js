'use strict';

/**
 * Billing / credits — queries the CodeBuddy metering API for an account's
 * plan and remaining credits ("积分").
 *
 * API (reverse-engineered from the WorkBuddy desktop client):
 *   POST {endpoint}/billing/meter/get-user-resource
 *   Body: { PageNumber, PageSize, ProductCode: "p_tcaca",
 *           Status: [0, 3],  (0=valid, 3=usedUp)
 *           PackageStartTimeRangeBegin/End }
 *   Response: data.Response.Data.Accounts[] — per-package credit pools.
 */

const https = require('https');

const COMMODITY_TEXT = {
  TCACA_code_001_PqouKr6QWV: '免费版',
  TCACA_code_002_AkiJS3ZHF5: 'Pro 月付',
  TCACA_code_005_maRGyrHhw1: 'Pro 月付',
  TCACA_code_006_DbXS0lrypC: 'Pro 试用',
  TCACA_code_007_nzdH5h4Nl0: '成长计划',
  TCACA_code_003_FAnt7lcmRT: 'Pro 年付',
  TCACA_code_008_cfWoLwvjU4: 'Pro 日付',
  TCACA_code_009_0XmEQc2xOf: '积分包',
  TCACA_code_023_4xbGhMrE6q: '青年版',
  TCACA_code_026_BaESVICNoi: '进阶版',
  TCACA_code_027_0FCGVA6vSa: '旗舰版',
  TCACA_code_028_NtpWi0jzXs: 'Bonus28',
  TCACA_code_029_6wCGEWquYy: 'Bonus29',
  TCACA_code_030_BjSt89qTvr: 'Bonus30',
  TCACA_code_038_OhvqZtiPKr: '积分包',
};

function packageName(code) {
  return COMMODITY_TEXT[code] || code || '未知套餐';
}

function parseTime(t) {
  if (!t) return null;
  const n = Number(t);
  if (typeof t === 'string' && /^\d+$/.test(t)) return n;
  const d = new Date(t).getTime();
  return Number.isFinite(d) ? d : null;
}

function formatDate(d) {
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, json: null, text });
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('billing request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/** Priority of a package when picking the "active" plan. */
function priorityOf(code) {
  const pro = ['TCACA_code_003_FAnt7lcmRT', 'TCACA_code_002_AkiJS3ZHF5', 'TCACA_code_005_maRGyrHhw1', 'TCACA_code_008_cfWoLwvjU4', 'TCACA_code_023_4xbGhMrE6q', 'TCACA_code_026_BaESVICNoi', 'TCACA_code_027_0FCGVA6vSa'];
  const bonus = ['TCACA_code_028_NtpWi0jzXs'];
  const extra = ['TCACA_code_009_0XmEQc2xOf', 'TCACA_code_038_OhvqZtiPKr'];
  const activity = ['TCACA_code_007_nzdH5h4Nl0', 'TCACA_code_029_6wCGEWquYy', 'TCACA_code_030_BjSt89qTvr'];
  if (pro.includes(code)) return 1;
  if (bonus.includes(code)) return 2;
  if (extra.includes(code)) return 3;
  if (activity.includes(code)) return 4;
  if (code === 'TCACA_code_006_DbXS0lrypC') return 5; // gift
  if (code === 'TCACA_code_001_PqouKr6QWV') return 6; // free
  return 7;
}

/**
 * Fetch credits for an account.
 * @param {object} opts { endpoint, token, userId, enterpriseId? }
 * @returns plan + usage + resources, or throws with statusCode
 */
async function getBilling({ endpoint, token, userId, enterpriseId }) {
  if (!token || !userId) {
    const err = new Error('account has no valid token / user id');
    err.statusCode = 401;
    throw err;
  }
  const now = new Date();
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3], // valid + usedUp
    PackageStartTimeRangeBegin: '2024-12-01 21:25:00',
    PackageStartTimeRangeEnd: formatDate(now),
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-User-Id': userId,
    ...(enterpriseId ? { 'X-Enterprise-Id': enterpriseId, 'X-Tenant-Id': enterpriseId } : {}),
  };
  const url = new URL(endpoint.replace(/\/$/, '') + '/billing/meter/get-user-resource');
  const resp = await postJson(url, body, headers);
  const accounts = resp.json && resp.json.data && resp.json.data.Response && resp.json.data.Response.Data
    ? resp.json.data.Response.Data.Accounts || []
    : null;
  if (accounts === null) {
    const err = new Error(`billing API failed (HTTP ${resp.status})${resp.json && resp.json.msg ? ': ' + resp.json.msg : ''}`);
    err.statusCode = resp.status || 502;
    throw err;
  }
  const dailyCodes = ['TCACA_code_001_PqouKr6QWV'];
  const refreshOnlyCodes = ['TCACA_code_002_AkiJS3ZHF5', 'TCACA_code_005_maRGyrHhw1', 'TCACA_code_003_FAnt7lcmRT', 'TCACA_code_008_cfWoLwvjU4', 'TCACA_code_023_4xbGhMrE6q', 'TCACA_code_026_BaESVICNoi', 'TCACA_code_027_0FCGVA6vSa', 'TCACA_code_028_NtpWi0jzXs'];
  const expireOnlyCodes = ['TCACA_code_007_nzdH5h4Nl0', 'TCACA_code_009_0XmEQc2xOf', 'TCACA_code_038_OhvqZtiPKr', 'TCACA_code_029_6wCGEWquYy', 'TCACA_code_030_BjSt89qTvr'];

  const resources = accounts
    .map((r) => {
      const isDaily = dailyCodes.includes(r.PackageCode);
      const endTime = isDaily ? r.CycleEndTime : r.DeductionEndTime;
      const total = Number(r.CycleCapacitySizePrecise) || 0;
      const left = Number(r.CycleCapacityRemainPrecise) || 0;
      return {
        id: r.ResourceId,
        name: isDaily ? '每日赠送' : packageName(r.PackageCode),
        packageCode: r.PackageCode,
        isDaily,
        total,
        used: Math.max(0, total - left),
        left,
        startAt: parseTime(r.DeductionStartTime) || parseTime(r.CycleStartTime),
        expireAt: parseTime(endTime),
        refreshAt: isDaily ? null : parseTime(r.CycleEndTime) && parseTime(r.CycleEndTime) + 1000,
      };
    })
    .sort((a, b) => priorityOf(a.packageCode) - priorityOf(b.packageCode) || (a.expireAt || Infinity) - (b.expireAt || Infinity));

  const total = resources.reduce((s, r) => s + r.total, 0);
  const used = resources.reduce((s, r) => s + r.used, 0);
  const left = resources.reduce((s, r) => s + r.left, 0);

  const planCodes = {
    proYear: 'TCACA_code_003_FAnt7lcmRT',
    proMon: 'TCACA_code_002_AkiJS3ZHF5',
    proMonPlus: 'TCACA_code_005_maRGyrHhw1',
    youth: 'TCACA_code_023_4xbGhMrE6q',
    advanced: 'TCACA_code_026_BaESVICNoi',
    flagship: 'TCACA_code_027_0FCGVA6vSa',
    trial: 'TCACA_code_006_DbXS0lrypC',
    freeMon: 'TCACA_code_008_cfWoLwvjU4',
  };
  const find = (codes) => accounts.find((r) => codes.includes(r.PackageCode));
  const proPlan = find([planCodes.proYear, planCodes.proMon, planCodes.proMonPlus]);
  const youthPlan = find([planCodes.youth]);
  const advancedPlan = find([planCodes.advanced]);
  const flagshipPlan = find([planCodes.flagship]);
  const trialPlan = find([planCodes.trial, planCodes.freeMon]);
  const active = flagshipPlan || advancedPlan || youthPlan || proPlan || trialPlan;

  return {
    ok: true,
    fetchedAt: Date.now(),
    plan: {
      isPro: !!proPlan,
      isYouth: !!youthPlan,
      isAdvanced: !!advancedPlan,
      isFlagship: !!flagshipPlan,
      isTrial: !!trialPlan,
      name: active ? packageName(active.PackageCode) : '免费版',
      expireAt: active ? parseTime(active.DeductionEndTime || active.ExpiredTime || active.CycleEndTime) : null,
      refreshAt: active ? parseTime(active.CycleEndTime) : null,
      renewFlag: active && Number(active.AutoRenewFlag) === 1 ? 1 : 0,
    },
    usage: { total, used, left },
    resources,
  };
}

module.exports = { getBilling };
