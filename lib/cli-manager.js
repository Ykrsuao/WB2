'use strict';

/**
 * CLI lifecycle manager.
 *
 * Spawns the WorkBuddy-bundled agent-cli (`codebuddy --serve`) as a child
 * process, waits until its gateway is ready, probes its port, and restarts
 * it with backoff if it ever crashes.
 *
 * The CLI reads the WorkBuddy desktop auth session file on its own, so no
 * token handling is needed here.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REQUEST_HEADER = 'X-CodeBuddy-Request';
const ENDPOINT_RE = /Endpoint\s+http:\/\/127\.0\.0\.1:(\d+)/;

/** Where the agent-cli lives inside a standard WorkBuddy install. */
function defaultCliDir() {
  return process.env.WORKBUDDY_CLI_DIR || 'D:\\workbuddy\\resources\\app.asar.unpacked\\cli';
}

function defaultCliBin(cliDir) {
  return path.join(cliDir, 'bin', 'codebuddy');
}

class CliManager {
  /**
   * @param {object} opts
   * @param {string} [opts.cliDir]       directory containing bin/codebuddy
   * @param {number} [opts.port]         fixed gateway port, or 0/undefined for auto-assign
   * @param {string} [opts.cwd]          working directory for the CLI (agent tools operate here)
   * @param {boolean} [opts.skipPermissions] pass --dangerously-skip-permissions (default true)
   * @param {string} [opts.extraArgs]    extra CLI args (space separated)
   */
  constructor(opts = {}) {
    this.cliDir = opts.cliDir || defaultCliDir();
    this.cliBin = opts.cliBin || defaultCliBin(this.cliDir);
    this.port = opts.port || 0;
    this.cwd = opts.cwd || process.cwd();
    this.skipPermissions = opts.skipPermissions !== false;
    this.extraArgs = opts.extraArgs || process.env.WORKBUDDY2API_CLI_ARGS || '';
    this.model = opts.model || process.env.WORKBUDDY2API_MODEL || null;
    this.effort = opts.effort || process.env.WORKBUDDY2API_EFFORT || null;
    this.acp = opts.acp !== undefined ? opts.acp : process.env.WORKBUDDY2API_DISABLE_ACP !== '1';
    this.tokenProvider = opts.tokenProvider || null; // async () => accessToken
    this.envOverrides = opts.envOverrides || null; // extra env (e.g. per-account HOME)
    this.systemPrompt = opts.systemPrompt || process.env.WORKBUDDY2API_SYSTEM_PROMPT || null;
    this.attachPort = opts.attachPort || 0; // if set, connect to an already-running CLI instead of spawning

    this.child = null;
    this.baseUrl = null;
    this.state = 'stopped'; // stopped | starting | ready | restarting
    this.startedAt = null;
    this.restartCount = 0;
    this.lastError = null;
    this._stopping = false;
    this._restartTimer = null;
    this._listeners = [];
  }

  onEvent(fn) {
    this._listeners.push(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners) {
      try {
        fn(event, payload);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  get info() {
    return {
      state: this.state,
      pid: this.child ? this.child.pid : null,
      port: this.port || null,
      baseUrl: this.baseUrl,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastError: this.lastError ? this.lastError.message : null,
      cliDir: this.cliDir,
      cliBin: this.cliBin,
      cliDir: this.cliDir,
      cliBin: this.cliBin,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      systemPrompt: this.systemPrompt ? String(this.systemPrompt).slice(0, 80) + '…' : null,
    };
  }

  /** One-shot HTTP GET with the required security header; resolves {status, body}. */
  _httpGet(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const req = http.get(url, { headers: { [REQUEST_HEADER]: '1' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve({ status: 0, body: '' });
      });
    });
  }

  async start() {
    if (this.state === 'ready' || this.state === 'starting') return;
    this._stopping = false;

    if (this.attachPort) {
      this.port = this.attachPort;
      this.baseUrl = `http://127.0.0.1:${this.attachPort}`;
      const ok = await this._waitReady(15000);
      if (ok) {
        this.state = 'ready';
        this.startedAt = Date.now();
        console.log(`[cli] attached to existing gateway at ${this.baseUrl}`);
        return;
      }
      throw new Error(`no gateway responding on port ${this.attachPort}`);
    }

    this.state = 'starting';
    this.lastError = null;
    console.log(`[cli] spawning ${this.cliBin} (cwd=${this.cwd}, port=${this.port || 'auto'})`);

    // per-account token (CODEBUDDY_AUTH_TOKEN takes precedence over the
    // desktop session file inside the CLI)
    let tokenEnv = {};
    if (this.tokenProvider) {
      try {
        const token = await this.tokenProvider();
        if (token) {
          tokenEnv = { CODEBUDDY_AUTH_TOKEN: token };
          console.log(`[cli] auth token injected (len=${token.length})`);
        } else {
          console.warn('[cli] tokenProvider returned no token; CLI may be unauthenticated');
        }
      } catch (e) {
        console.warn('[cli] tokenProvider failed:', e.message);
      }
    }

    const args = [this.cliBin, '--serve', '--host', '127.0.0.1'];
    if (this.port) args.push('--port', String(this.port));
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.systemPrompt) args.push('--system-prompt', this.systemPrompt);
    // ACP streamable-http must be enabled for the chat engine (thinking + real
    // token streaming). Without it, /api/v1/acp records prompts but never runs them.
    if (this.acp !== false) args.push('--acp', '--acp-transport', 'streamable-http');
    if (this.skipPermissions) args.push('--dangerously-skip-permissions');
    if (this.extraArgs) args.push(...this.extraArgs.split(/\s+/).filter(Boolean));

    const child = spawn(process.execPath, args, {
      cwd: this.cwd,
      env: { ...process.env, ...tokenEnv, ...(this.envOverrides || {}), FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const onData = (buf, isErr) => {
      const text = buf.toString();
      console.log(`[cli${isErr ? ':err' : ''}] ${text.trimEnd()}`);
      const m = ENDPOINT_RE.exec(text);
      if (m && !this.baseUrl) {
        this.port = Number(m[1]);
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        console.log(`[cli] gateway detected on port ${this.port}`);
      }
    };
    child.stdout.on('data', (b) => onData(b, false));
    child.stderr.on('data', (b) => onData(b, true));

    child.on('exit', (code, signal) => {
      const wasReady = this.state === 'ready';
      this.child = null;
      this.baseUrl = null;
      this.state = 'stopped';
      if (this._stopping) {
        console.log(`[cli] exited (code=${code}, signal=${signal}) — shutting down`);
        return;
      }
      this.restartCount++;
      this.lastError = new Error(`CLI exited code=${code} signal=${signal}`);
      console.log(`[cli] exited unexpectedly (code=${code}, signal=${signal}); restart #${this.restartCount}`);
      this._emit('crash', { code, signal, restartCount: this.restartCount, wasReady });
      const delay = Math.min(30000, 2000 * 2 ** Math.min(this.restartCount, 4));
      this._restartTimer = setTimeout(() => {
        this.start().catch((e) => {
          this.lastError = e;
          console.error('[cli] restart failed:', e.message);
        });
      }, delay);
    });

    child.on('error', (err) => {
      this.lastError = err;
      console.error('[cli] spawn error:', err.message);
      this._emit('error', err);
    });

    const ready = await this._waitReady(120000);
    if (!ready) {
      this.lastError = new Error('CLI gateway did not become ready in time');
      console.error('[cli] gateway not ready; lastError set');
      return false;
    }
    this.state = 'ready';
    this.startedAt = Date.now();
    console.log(`[cli] ready at ${this.baseUrl} (pid=${child.pid})`);
    this._emit('ready', { baseUrl: this.baseUrl, pid: child.pid });
    return true;
  }

  async _waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probePort = this.port || this.attachPort;
      if (probePort) {
        const { status, body } = await this._httpGet(`http://127.0.0.1:${probePort}/api/v1/auth/status`);
        if (status === 200) {
          try {
            const parsed = JSON.parse(body);
            console.log(`[cli] auth/status -> ${JSON.stringify(parsed)}`);
          } catch {
            /* ignore */
          }
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async stop() {
    this._stopping = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      console.log('[cli] stopping child...');
      child.kill();
    }
    if (this.attachPort) this.baseUrl = null;
    this.state = 'stopped';
  }
}

module.exports = { CliManager, defaultCliDir, defaultCliBin };
