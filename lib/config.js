'use strict';

/**
 * Runtime config — read/write WORKBUDDY2API_* values in .env so the web
 * panel can change settings (system prompt, model, ...) without editing
 * files by hand. Changing values that affect the CLI takes effect via
 * CliPool.restartAll().
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function readEnv() {
  const out = {};
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env yet */
  }
  return out;
}

function writeEnv(env) {
  const keys = Object.keys(env).sort();
  const lines = keys.map((k) => `${k}=${env[k]}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

/** Current live config snapshot (merged env + runtime values). */
function getConfig(runtime) {
  const env = readEnv();
  return {
    apiKeySet: !!env.WORKBUDDY2API_API_KEY,
    host: process.env.WORKBUDDY2API_HOST || env.WORKBUDDY2API_HOST || '127.0.0.1',
    port: Number(process.env.WORKBUDDY2API_PORT || env.WORKBUDDY2API_PORT) || 8787,
    lb: (process.env.WORKBUDDY2API_LB || env.WORKBUDDY2API_LB || 'first').toLowerCase(),
    model: process.env.WORKBUDDY2API_MODEL || env.WORKBUDDY2API_MODEL || '',
    effort: process.env.WORKBUDDY2API_EFFORT || env.WORKBUDDY2API_EFFORT || '',
    cliArgs: process.env.WORKBUDDY2API_CLI_ARGS || env.WORKBUDDY2API_CLI_ARGS || '',
    accountsFile: process.env.WORKBUDDY2API_ACCOUNTS_FILE || env.WORKBUDDY2API_ACCOUNTS_FILE || '',
    runtime: runtime || null,
  };
}

/**
 * Apply a config patch (subset of keys), persist to .env and update
 * process.env for the running service. Returns the keys that were changed.
 * Returns {ok, changed: [...]} — callers should restart CLIs if a CLI-level
 * key (model/effort/cliArgs) changed.
 */
function applyPatch(patch) {
  const env = readEnv();
  const cliKeys = ['WORKBUDDY2API_MODEL', 'WORKBUDDY2API_EFFORT', 'WORKBUDDY2API_CLI_ARGS'];
  const changed = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith('WORKBUDDY2API_')) continue;
    const str = value === null || value === undefined ? '' : String(value);
    if ((env[key] || '') !== str) {
      if (str === '') delete env[key];
      else env[key] = str;
      process.env[key] = str === '' ? undefined : str;
      changed.push(key);
    }
  }
  if (changed.length > 0) writeEnv(env);
  return { ok: true, changed, needsCliRestart: changed.some((k) => cliKeys.includes(k)) };
}

module.exports = { readEnv, writeEnv, getConfig, applyPatch, ENV_PATH };
