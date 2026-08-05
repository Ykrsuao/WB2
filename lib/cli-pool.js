'use strict';

/**
 * CliPool — manages one isolated agent-cli instance per account.
 *
 * Each account's CLI is spawned with CODEBUDDY_AUTH_TOKEN=<account token> so
 * accounts never share credentials. Tokens are (re)resolved per spawn, so a
 * refreshed token is picked up on restart.
 */

const { CliManager } = require('./cli-manager');

/** Build per-account HOME env overrides (isolation on each platform). */
function homeEnv(home) {
  if (process.platform === 'win32') return { USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) };
  return { HOME: home };
}

class CliPool {
  /**
   * @param {object} opts
   * @param {AccountsRegistry} opts.accounts
   * @param {object} opts.cliOptions  base CliManager options (cliDir, cwd, model, effort, ...)
   */
  constructor({ accounts, cliOptions = {} }) {
    this.accounts = accounts;
    this.cliOptions = cliOptions;
    this.instances = new Map(); // accountId -> CliManager
  }

  _managerFor(account) {
    if (this.instances.has(account.id)) return this.instances.get(account.id);
    const manager = new CliManager({
      ...this.cliOptions,
      // per-account token is resolved lazily by cli-manager via envProvider
      tokenProvider: () => this.accounts.getAccessToken(account).then((r) => r.token),
      // per-account HOME isolates config dirs / login sessions of the CLI
      envOverrides: account.home ? homeEnv(account.home) : null,
    });
    this.instances.set(account.id, manager);
    return manager;
  }

  /** Get (and start if needed) the CLI for a pre-picked account record. */
  async getCliFor(account) {
    if (!account) return { account: null, cli: null };
    const cli = this._managerFor(account);
    if (cli.state === 'stopped' || cli.state === 'restarting') {
      await cli.start();
    }
    return { account, cli };
  }

  /** Get (and start if needed) the CLI for an account id or the default account. */
  async getCli(requestedId) {
    const account = this.accounts.resolve(requestedId);
    return this.getCliFor(account);
  }

  getCliSync(requestedId) {
    const account = this.accounts.resolve(requestedId);
    if (!account) return { account: null, cli: null };
    return { account, cli: this._managerFor(account) };
  }

  /** Stop all instances (shutdown). */
  async stopAll() {
    await Promise.all([...this.instances.values()].map((m) => m.stop()));
    this.instances.clear();
  }

  /** Stop + reset all instances so they re-spawn with new options on next use. */
  async restartAll() {
    await this.stopAll();
    console.log('[pool] all CLI instances stopped (will re-spawn with new config)');
  }

  status() {
    const out = {};
    for (const [id, m] of this.instances) {
      out[id] = { ...m.info, account: (this.accounts.get(id) || {}).name || id };
    }
    return out;
  }
}

module.exports = { CliPool };
