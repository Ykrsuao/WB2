'use strict';

/**
 * Minimal ACP (Agent Client Protocol) streamable-http client for the
 * CodeBuddy CLI gateway.
 *
 * Verified protocol (against cli 2.115.0):
 *   1. GET  /api/v1/acp            -> header `Acp-Connection-Id`, SSE keep-alive
 *   2. POST /api/v1/acp (initialize)  -> response body is SSE with JSON-RPC result
 *   3. POST /api/v1/acp (session/new) -> { cwd, mcpServers: [] } -> sessionId
 *   4. POST /api/v1/acp (session/prompt) -> response body STREAMS events:
 *        session_info_update / agent_thought_chunk / agent_message_chunk /
 *        tool_call / tool_call_update / session_end ...
 *
 * The CLI gateway must be started with `--acp --acp-transport streamable-http`,
 * otherwise prompts are recorded but never executed.
 */

const http = require('http');

class AcpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class AcpConnection {
  constructor(baseUrl, { requestTimeoutMs = 30000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectionId = null;
    this.getStream = null;
    this.nextId = 1;
    this.closed = false;
  }

  /** Open the GET SSE stream and obtain the connection id. */
  open() {
    return new Promise((resolve, reject) => {
      const req = http.get(this.baseUrl + '/api/v1/acp', {
        headers: { 'X-CodeBuddy-Request': '1', Accept: 'text/event-stream' },
      }, (res) => {
        this.getStream = res;
        this.connectionId = res.headers['acp-connection-id'];
        if (!this.connectionId) {
          reject(new AcpError('NO_CONNECTION_ID', 'server did not return Acp-Connection-Id'));
          return;
        }
        // keep the stream drained so the server keeps pushing
        res.on('data', () => {});
        res.on('error', () => {});
        resolve(this.connectionId);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('ACP connect timeout')));
    });
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   * Short-lived calls (initialize/session/new/...) read the whole body.
   * Returns the `result` object (throws AcpError on JSON-RPC error).
   */
  rpc(method, params) {
    const id = this.nextId++;
    return this._post(method, params, id).then((frames) => {
      for (const msg of frames) {
        if (msg && msg.id === id) {
          if (msg.error) throw new AcpError(msg.error.code, msg.error.message, msg.error.data);
          return msg.result;
        }
      }
      throw new AcpError('NO_RESPONSE', `no response for ${method}`);
    });
  }

  /**
   * Create a session. Some CLI builds only announce the sessionId via the
   * `session/update` notification (no id-matched result), so we accept either.
   */
  async sessionNew(cwd, mcpServers = []) {
    const id = this.nextId++;
    const frames = await this._post('session/new', { cwd, mcpServers }, id);
    for (const msg of frames) {
      if (!msg) continue;
      if (msg.id === id) {
        if (msg.error) throw new AcpError(msg.error.code, msg.error.message, msg.error.data);
        if (msg.result && msg.result.sessionId) return msg.result;
      }
    }
    for (const msg of frames) {
      if (msg && msg.method === 'session/update' && msg.params && msg.params.sessionId) {
        return { sessionId: msg.params.sessionId };
      }
    }
    throw new AcpError('NO_SESSION', 'session/new returned no sessionId');
  }

  /** POST a JSON-RPC body, read the full response, return parsed messages. */
  _post(method, params, id) {
    const body = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(this.baseUrl + '/api/v1/acp', {
        method: 'POST',
        headers: {
          'X-CodeBuddy-Request': '1',
          'Content-Type': 'application/json',
          'Acp-Connection-Id': this.connectionId,
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const frames = [];
          for (const frame of splitSse(text)) {
            if (frame && frame.data) frames.push(frame.data);
          }
          resolve(frames);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(this.requestTimeoutMs, () => req.destroy(new Error(`ACP rpc ${method} timeout`)));
      req.write(payload);
      req.end();
    });
  }

  /**
   * Send session/prompt and stream the response events.
   * @param {string} sessionId
   * @param {Array} promptBlocks  [{type:'text', text}]
   * @param {(event: {type:string, text?:string, data?:object}) => void} onEvent
   * @returns {Promise<{stopReason: string, errorMessage?: string}>}
   */
  prompt(sessionId, promptBlocks, onEvent) {
    const id = this.nextId++;
    const body = {
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: { sessionId, prompt: promptBlocks },
    };
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(this.baseUrl + '/api/v1/acp', {
        method: 'POST',
        headers: {
          'X-CodeBuddy-Request': '1',
          'Content-Type': 'application/json',
          'Acp-Connection-Id': this.connectionId,
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new AcpError('HTTP_' + res.statusCode, `prompt failed (HTTP ${res.statusCode})`));
          return;
        }
        let buffer = '';
        let settled = false;
        const finish = (err, result) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve(result);
        };
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const parsed = parseFrame(frame);
            if (!parsed || !parsed.data) continue;
            const msg = parsed.data;
            if (msg.id === id) {
              if (msg.error) finish(new AcpError(msg.error.code, msg.error.message, msg.error.data));
              else finish(null, msg.result || {});
              continue;
            }
            if (msg.method === 'session/update') {
              const upd = msg.params && msg.params.update;
              if (!upd || typeof upd !== 'object') continue;
              const type = upd.sessionUpdate;
              let text = '';
              if (upd.content && typeof upd.content === 'object') {
                text = upd.content.text || upd.content.data || '';
              }
              const meta = { type, text, data: upd, sessionId: msg.params.sessionId };
              if (type === 'session_end') {
                onEvent && onEvent({ ...meta, stopReason: upd.stopReason, errorMessage: upd.errorMessage });
                continue;
              }
              onEvent && onEvent(meta);
            }
          }
        });
        res.on('end', () => finish(new AcpError('NO_SESSION_END', 'prompt stream ended without session_end')));
        res.on('error', (e) => finish(e));
        res.on('close', () => finish(new AcpError('STREAM_CLOSED', 'prompt stream closed early')));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.getStream) {
      try {
        this.getStream.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

function splitSse(text) {
  const out = [];
  for (const frame of text.split('\n\n')) {
    const parsed = parseFrame(frame);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseFrame(frame) {
  let event = null;
  let data = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data = line.slice(5).trim();
  }
  if (data === null) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

module.exports = { AcpConnection, AcpError };
