'use strict';

/**
 * Chat handlers.
 *
 * /v1/chat/completions  -> direct LLM engine (no CLI process):
 *   forwards to {endpoint}/v2/chat/completions with the account token.
 *
 * /v1/agent/runs*       -> CLI gateway passthrough (agentic tool use),
 *   only spawns the agent-cli when these endpoints are actually used.
 */

const http = require('http');
const { uuid, sse, sendError, sendJson } = require('./util');
const { directChat, directNonStream } = require('./direct-llm');

// ---------------------------------------------------------------- gateway helpers (agent passthrough)

function gatewayRequest(baseUrl, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      baseUrl + path,
      {
        method,
        headers: {
          'X-CodeBuddy-Request': '1',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
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
            /* not JSON */
          }
          resolve({ status: res.statusCode, text, json: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function gatewayStream(baseUrl, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      baseUrl + path,
      { headers: { 'X-CodeBuddy-Request': '1', Accept: 'text/event-stream', ...headers } },
      (res) => resolve({ status: res.statusCode, res })
    );
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- message normalization

/** Normalize OpenAI-style messages (strings or content blocks) to strings. */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const role = m.role || 'user';
    const content = Array.isArray(m.content)
      ? m.content
          .map((b) => {
            if (b && b.type === 'text') return b.text;
            if (b && typeof b.text === 'string') return b.text;
            if (b && b.type === 'image_url' && b.image_url && b.image_url.url) {
              return `[图片: ${b.image_url.url}]`;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n')
      : typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
    return { role, content };
  }).filter((m) => m.content);
}

/**
 * Normalize messages for the direct LLM engine, preserving the fields that
 * OpenAI function calling needs: tool_calls (assistant), tool_call_id (tool
 * result) and name (function role). Empty assistant messages that only carry
 * tool_calls are kept.
 */
function normalizeDirectMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((b) => {
          if (b && b.type === 'text') return b.text;
          if (b && typeof b.text === 'string') return b.text;
          if (b && b.type === 'image_url' && b.image_url && b.image_url.url) return `[图片: ${b.image_url.url}]`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else if (typeof content !== 'string') {
      content = content === null || content === undefined ? '' : JSON.stringify(content);
    }
    const msg = { role, content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name) msg.name = m.name;
    if (msg.content || msg.tool_calls) out.push(msg);
  }
  return out;
}

// ---------------------------------------------------------------- /v1/chat/completions (direct LLM)

/**
 * POST /v1/chat/completions — OpenAI-compatible, backed by the direct LLM.
 * @param {object} _cli        unused (kept for signature compat)
 * @param {object} accountOpts { id, token, userId, endpoint }
 */
async function handleChatCompletions(_cli, req, res, body, accountOpts) {
  if (!accountOpts || !accountOpts.token) {
    sendError(res, 401, 'NO_TOKEN', `account '${accountOpts && accountOpts.id || '?'}' has no valid token`);
    return;
  }
  const messages = normalizeDirectMessages(body.messages);
  if (messages.length === 0) {
    sendError(res, 400, 'BAD_REQUEST', 'messages must be a non-empty array');
    return;
  }
  const stream = body.stream === true;
  const model = typeof body.model === 'string' && body.model ? body.model : undefined;
  const thinking = body.thinking !== undefined ? body.thinking : body.thought_level;
  const temperature = body.temperature;
  const maxTokens = body.max_tokens;
  const tools = body.tools; // OpenAI function calling (client executes, returns role:"tool")
  const toolChoice = body.tool_choice;

  const chatId = `chatcmpl-${uuid()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelOut = model || 'auto';

  try {
    if (stream) {
      const iter = await directChat({
        endpoint: accountOpts.endpoint,
        token: accountOpts.token,
        userId: accountOpts.userId,
        model,
        messages,
        stream: true,
        thinking,
        temperature,
        maxTokens,
        tools,
        toolChoice,
      });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(
        sse('chat.completion.chunk', {
          id: chatId, object: 'chat.completion.chunk', created, model: modelOut,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })
      );
      let finished = false;
      for await (const d of iter) {
        const choice = d.choices && d.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          res.write(
            sse('chat.completion.chunk', {
              id: chatId, object: 'chat.completion.chunk', created, model: modelOut,
              choices: [{ index: 0, delta: { reasoning_content: delta.reasoning_content }, finish_reason: null }],
            })
          );
        }
        if (delta.content) {
          res.write(
            sse('chat.completion.chunk', {
              id: chatId, object: 'chat.completion.chunk', created, model: modelOut,
              choices: [{ index: 0, delta: { content: delta.content }, finish_reason: null }],
            })
          );
        }
        if (Array.isArray(delta.tool_calls)) {
          res.write(
            sse('chat.completion.chunk', {
              id: chatId, object: 'chat.completion.chunk', created, model: modelOut,
              choices: [{ index: 0, delta: { tool_calls: delta.tool_calls }, finish_reason: null }],
            })
          );
        }
        if (choice.finish_reason && !finished) {
          finished = true;
          res.write(
            sse('chat.completion.chunk', {
              id: chatId, object: 'chat.completion.chunk', created, model: modelOut,
              choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
            })
          );
        }
      }
      if (!finished) {
        res.write(
          sse('chat.completion.chunk', {
            id: chatId, object: 'chat.completion.chunk', created, model: modelOut,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // non-stream: stream from backend and aggregate server-side
    const resp = await directNonStream({
      endpoint: accountOpts.endpoint,
      token: accountOpts.token,
      userId: accountOpts.userId,
      model,
      messages,
      thinking,
      temperature,
      maxTokens,
      tools,
      toolChoice,
    });
    const d = resp.json;
    const choice = d.choices && d.choices[0];
    const msg = (choice && choice.message) || {};
    sendJson(res, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model: d.model || modelOut,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: msg.content || '',
            ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
            ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          },
          finish_reason: (choice && choice.finish_reason) || 'stop',
        },
      ],
      usage: d.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    sendError(res, e.statusCode || 502, e.code || 'LLM_FAILED', e.message);
  }
}

// ---------------------------------------------------------------- /v1/agent/runs (CLI passthrough)

/** POST /v1/agent/runs — raw passthrough (Gateway Protocol message body). */
async function handleAgentRun(cli, req, res, body) {
  if (!cli || !cli.baseUrl) return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
  try {
    const resp = await gatewayRequest(cli.baseUrl, 'POST', '/api/v1/runs', body);
    res.writeHead(resp.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(resp.text);
  } catch (e) {
    sendError(res, 502, 'GATEWAY_ERROR', e.message);
  }
}

/** GET /v1/agent/runs/:id/stream — raw SSE passthrough. */
async function handleAgentRunStream(cli, req, res, runId) {
  if (!cli || !cli.baseUrl) return sendError(res, 503, 'CLI_NOT_READY', 'agent gateway is not ready');
  try {
    const { status, res: upstream } = await gatewayStream(cli.baseUrl, `/api/v1/runs/${runId}/stream`);
    res.writeHead(status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    upstream.pipe(res);
    req.on('close', () => upstream.destroy());
  } catch (e) {
    sendError(res, 502, 'GATEWAY_ERROR', e.message);
  }
}

module.exports = {
  handleChatCompletions,
  handleAgentRun,
  handleAgentRunStream,
  normalizeMessages,
  normalizeDirectMessages,
  gatewayRequest,
};
