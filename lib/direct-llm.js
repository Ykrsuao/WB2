'use strict';

/**
 * Direct LLM engine — talks straight to the CodeBuddy backend
 * (`POST {endpoint}/v2/chat/completions`, OpenAI-compatible, SSE streaming).
 *
 * This is the "pure API" path: NO agent-cli process, NO tools, NO file system
 * access. It only forwards the model request with the account's token.
 *
 * Verified against the real backend:
 *   - streaming: OpenAI SSE with `choices[].delta.content` and
 *     `choices[].delta.reasoning_content` (thinking) when `reasoning_effort`
 *     is set (low/medium/high/max).
 *   - auth: Authorization: Bearer <token> + X-User-Id: <uid>.
 */

const https = require('https');

const DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
const LLM_PATH = '/v2/chat/completions';

/** Map our thinking level to the backend reasoning_effort param. */
function toReasoningEffort(thinking) {
  if (thinking === undefined || thinking === null || thinking === false || thinking === 'disabled') return undefined;
  if (thinking === true) return 'high';
  const s = String(thinking).toLowerCase();
  const ok = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (ok.includes(s)) return s === 'xhigh' ? 'max' : s;
  if (s === 'enabled') return 'high';
  return undefined;
}

/**
 * Call the backend chat completions endpoint (backend always streams).
 * @param {object} opts { endpoint, token, userId, model, messages, stream?,
 *                        thinking?, temperature?, maxTokens?, tools?, toolChoice?, signal? }
 * @returns async iterable of OpenAI SSE payload objects.
 */
function directChat(opts) {
  const {
    endpoint = process.env.WORKBUDDY2API_ENDPOINT || DEFAULT_ENDPOINT,
    token,
    userId,
    model = 'auto',
    messages = [],
    thinking,
    temperature,
    maxTokens = 4096,
    tools,
    toolChoice,
    signal,
  } = opts;

  const body = {
    model,
    messages,
    stream: true, // backend requires streaming; non-stream is aggregated server-side
    max_tokens: maxTokens,
  };
  // Tool calling (function calling): forwarded as-is; the client executes the
  // tool and sends results back as role:"tool" messages.
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  if (toolChoice !== undefined && toolChoice !== null) body.tool_choice = toolChoice;
  // thinking param wins; fall back to WORKBUDDY2API_EFFORT (old CLI default) so
  // thinking stays on out-of-the-box, while clients can opt out with thinking:false.
  const effort = toReasoningEffort(thinking !== undefined ? thinking : process.env.WORKBUDDY2API_EFFORT);
  if (effort) body.reasoning_effort = effort;
  if (temperature !== undefined) body.temperature = temperature;

  const url = new URL(endpoint.replace(/\/$/, '') + LLM_PATH);
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${token}`,
    'X-User-Id': userId,
    'User-Agent': 'workbuddy2api/0.1',
    'Content-Length': Buffer.byteLength(payload),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const err = new Error(`LLM request failed (HTTP ${res.statusCode}): ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`);
            err.statusCode = res.statusCode;
            reject(err);
          });
          return;
        }
        resolve(createSSEIterable(res));
      }
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.write(payload);
    req.end();
  });
}

/**
 * Non-streaming call: stream from the backend, aggregate, return the full
 * OpenAI-compatible JSON response object { status, json }.
 */
async function directNonStream(opts) {
  const iter = await directChat(opts);
  const agg = await aggregateStream(iter);
  return {
    status: 200,
    json: {
      id: 'chatcmpl-direct',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: agg.model || opts.model || 'auto',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: agg.content,
            ...(agg.reasoning ? { reasoning_content: agg.reasoning } : {}),
            ...(agg.toolCalls ? { tool_calls: agg.toolCalls } : {}),
          },
          finish_reason: agg.finishReason || 'stop',
        },
      ],
      usage: agg.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

/** Parse an OpenAI SSE stream into an async iterable of payload objects. */
function createSSEIterable(res) {
  const asyncIterator = {
    [Symbol.asyncIterator]() {
      let buffer = '';
      let done = false;
      let resolveNext = null;
      const queue = [];

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let data = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (data === null || data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            if (resolveNext) {
              resolveNext({ value: obj, done: false });
              resolveNext = null;
            } else {
              queue.push(obj);
            }
          } catch {
            /* skip partial */
          }
        }
      });
      res.on('end', () => {
        done = true;
        if (resolveNext) {
          resolveNext({ value: undefined, done: true });
          resolveNext = null;
        }
      });
      res.on('error', (e) => {
        done = true;
        if (resolveNext) {
          resolveNext({ value: undefined, done: true });
          resolveNext = null;
        }
      });

      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };
  return asyncIterator;
}

/** Aggregate a streamed response into the final content + reasoning. */
async function aggregateStream(iterable) {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let model = null;
  let usage = null;
  const toolCalls = new Map(); // index -> { id, type, function:{name, arguments} }
  for await (const d of iterable) {
    const choice = d.choices && d.choices[0];
    if (!choice) continue;
    if (choice.delta) {
      if (choice.delta.content) content += choice.delta.content;
      if (choice.delta.reasoning_content) reasoning += choice.delta.reasoning_content;
      if (Array.isArray(choice.delta.tool_calls)) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index || 0;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } });
          }
          const cur = toolCalls.get(idx);
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function) {
            if (tc.function.name) cur.function.name += tc.function.name;
            if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
          }
        }
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (d.model) model = d.model;
    if (d.usage) usage = d.usage;
  }
  return {
    content,
    reasoning,
    finishReason,
    model,
    usage,
    toolCalls: toolCalls.size > 0 ? [...toolCalls.values()] : null,
  };
}

module.exports = { directChat, directNonStream, aggregateStream, toReasoningEffort, DEFAULT_ENDPOINT };
