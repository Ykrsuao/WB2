'use strict';

/**
 * Model registry for /v1/models.
 *
 * Two sources:
 *   1. Static catalog from the WorkBuddy product config
 *      (app.asar.unpacked/cli/product.json -> models[]).
 *   2. Live models discovered from an agent-cli session (`models.availableModels`
 *      in the ACP session/new result) — these are the models actually selectable
 *      right now (e.g. kimi-k3-1, glm-5.2) and may differ from the static catalog.
 */

const fs = require('fs');
const path = require('path');

const FALLBACK_MODELS = [
  { id: 'auto', name: 'Auto' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5.0', name: 'GLM-5.0' },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
  { id: 'kimi-k3-1', name: 'Kimi-K3-1' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
  { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking' },
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash' },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2' },
  { id: 'deepseek-r1-0528', name: 'DeepSeek-R1-0528' },
  { id: 'hy3', name: 'Hy3' },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos' },
  { id: 'hunyuan-2.0-thinking', name: 'Hunyuan-2.0-Thinking' },
];

const PRODUCT_JSON_CANDIDATES = [
  process.env.WORKBUDDY_PRODUCT_JSON,
  path.join('D:', 'workbuddy', 'resources', 'app.asar.unpacked', 'cli', 'product.json'),
].filter(Boolean);

let staticCache = null;

/** Live models per account, discovered from CLI sessions. */
const liveCache = new Map(); // accountId -> { models: [], updatedAt: number }
const LIVE_TTL_MS = 10 * 60 * 1000; // refresh at most every 10 min

function loadStaticModels() {
  if (staticCache) return staticCache;
  const fromFile = [];
  for (const p of PRODUCT_JSON_CANDIDATES) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(d.models) && d.models.length > 0) {
        fromFile.push(...d.models.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, name: m.name || m.id })));
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  // Merge the file catalog with the fallback catalog (fallback wins on id):
  // guarantees models like kimi-k3-1 / glm-5.2 are always listed even if the
  // on-disk product.json is older than the backend's current catalog.
  const map = new Map();
  for (const m of fromFile) map.set(m.id, m);
  for (const m of FALLBACK_MODELS) map.set(m.id, m);
  staticCache = [...map.values()];
  return staticCache;
}

/** Store live models discovered from a CLI session. */
function updateLive(accountId, availableModels) {
  if (!Array.isArray(availableModels) || availableModels.length === 0) return;
  const models = availableModels
    .map((m) => ({
      id: m.modelId || m.id,
      name: m.name || m.modelId || m.id,
      supportsImages: !!(m._meta && m._meta.supportsImages),
      supportsReasoning: !!(m._meta && m._meta.supportsReasoning),
    }))
    .filter((m) => m.id);
  liveCache.set(accountId, { models, updatedAt: Date.now() });
}

/** Live models for an account id, or merged across all accounts when null. */
function getLive(accountId) {
  if (accountId) {
    const entry = liveCache.get(accountId);
    return entry ? entry.models : null;
  }
  const merged = new Map();
  for (const entry of liveCache.values()) {
    for (const m of entry.models) merged.set(m.id, m);
  }
  return merged.size > 0 ? [...merged.values()] : null;
}

/** True if any account has a fresh live-models cache. */
function isLiveFresh() {
  let newest = 0;
  for (const e of liveCache.values()) newest = Math.max(newest, e.updatedAt || 0);
  return newest > 0 && Date.now() - newest < LIVE_TTL_MS;
}

/**
 * Fetch the live model list straight from an agent-cli gateway (one short ACP
 * session) and cache it. Returns true on success.
 */
async function refreshLiveFromCli(baseUrl, cwd, accountId) {
  const { AcpConnection } = require('./acp');
  const conn = new AcpConnection(baseUrl);
  try {
    await conn.open();
    await conn.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const result = await conn.sessionNew(cwd);
    if (result && result.models && Array.isArray(result.models.availableModels)) {
      updateLive(accountId, result.models.availableModels);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    conn.close();
  }
}

/** Merge static + live into one de-duplicated list (live wins). */
function mergedModels(accountId) {
  const map = new Map();
  for (const m of loadStaticModels()) map.set(m.id, { ...m, source: 'static' });
  const live = getLive(accountId);
  if (live) {
    for (const m of live) map.set(m.id, { ...m, source: 'live' });
  }
  return [...map.values()];
}

/** OpenAI-compatible /v1/models response body. Live models are merged across
 *  all accounts (the selectable catalog is the same per backend). */
function modelsList() {
  return {
    object: 'list',
    data: mergedModels().map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'workbuddy',
      name: m.name,
      display_name: m.name,
      ...(m.supportsReasoning !== undefined ? { supports_reasoning: m.supportsReasoning } : {}),
      ...(m.supportsImages !== undefined ? { supports_images: m.supportsImages } : {}),
      source: m.source,
    })),
  };
}

/** Find a single model by id (searches static + live). */
function findModel(id) {
  const m = mergedModels().find((x) => x.id === id);
  if (!m) return null;
  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    name: m.name,
    display_name: m.name,
  };
}

module.exports = { loadStaticModels, updateLive, getLive, isLiveFresh, refreshLiveFromCli, mergedModels, modelsList, findModel };
