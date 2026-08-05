'use strict';

/**
 * Anthropic Messages API compatibility layer — lets Claude Code / Cursor /
 * Continue-style tools connect to workbuddy2api as if it were Anthropic.
 *
 *   POST /v1/messages
 *   Body: { model, max_tokens, system?, messages, stream?, thinking?, metadata? }
 *   Auth: Authorization: Bearer <api key>   (workbuddy2api's own key)
 *
 * Maps to the direct LLM engine; streams Anthropic SSE events
 * (message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop).
 */

const { uuid, sse, sendError, sendJson } = require('./util');
const { directChat, directNonStream } = require('./direct-llm');
const { normalizeMessages } = require('./chat');

/** Map a client-requested model id to one we can actually use. */
function resolveModel(requested, knownModels) {
  if (!requested) return undefined;
  const id = String(requested).toLowerCase();
  if (id.startsWith('claude') || id.startsWith('anthropic')) {
    // Claude Code sends claude-* ids; fall back to our default (or a configured map)
    return process.env.WORKBUDDY2API_ANTHROPIC_MODEL || undefined;
  }
  if (knownModels && knownModels.has(id)) return requested;
  // unknown custom id -> keep it; backend may accept it
  return requested;
}

/** Convert Anthropic content blocks / strings to OpenAI message content. */
function anthropicMessageToOpenAI(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  const content = Array.isArray(m.content)
    ? m.content
        .map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'thinking') return { type: 'text', text: `[thinking]\n${b.thinking}` };
          if (b.type === 'image' && (b.source && b.source.data)) {
            return { type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } };
          }
          return '';
        })
        .filter(Boolean)
    : m.content;
  return { role, content };
}

function anthropicMessagesToOpenAI(body) {
  const out = [];
  if (body.system) {
    const sysText = Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : String(body.system);
    if (sysText) out.push({ role: 'system', content: sysText });
  }
  for (const m of body.messages || []) {
    const converted = anthropicMessageToOpenAI(m);
    if (converted.content) out.push(converted);
  }
  return out;
}

/** Build the Anthropic message id + usage from our engine output. */
function anthropicResponse(msgId, model, agg) {
  const content = [];
  if (agg.reasoning) content.push({ type: 'thinking', thinking: agg.reasoning });
  if (agg.content) content.push({ type: 'text', text: agg.content });
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model: model || 'default',
    content,
    stop_reason: agg.finishReason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: (agg.usage && agg.usage.prompt_tokens) || 0,
      output_tokens: (agg.usage && agg.usage.completion_tokens) || 0,
    },
  };
}

/**
 * POST /v1/messages — Anthropic-compatible.
 * @param {object} accountOpts { id, token, userId, endpoint, knownModels }
 */
async function handleMessages(_cli, req, res, body, accountOpts) {
  if (!accountOpts || !accountOpts.token) {
    sendError(res, 401, 'NO_TOKEN', 'account has no valid token');
    return;
  }
  const messages = normalizeMessages(anthropicMessagesToOpenAI(body));
  if (messages.length === 0) {
    sendError(res, 400, 'BAD_REQUEST', 'messages must be a non-empty array');
    return;
  }
  const stream = body.stream === true;
  const model = resolveModel(body.model, accountOpts.knownModels);
  const thinking =
    body.thinking && body.thinking.type === 'enabled' ? body.thinking.type === 'enabled' && 'high' : body.thinking;
  const maxTokens = body.max_tokens;

  const msgId = `msg_${uuid().replace(/-/g, '')}`;
  const modelOut = model || 'default';

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
        maxTokens,
      });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(
        sse('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: modelOut,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
      );
      let blockIndex = 0;
      let finished = false;

      const openBlock = (type) => {
        const contentBlock = type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        res.write(sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: contentBlock }));
      };
      const closeBlock = () => {
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
        blockIndex += 1;
      };

      for await (const d of iter) {
        const choice = d.choices && d.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          openBlock('thinking');
          res.write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            })
          );
          closeBlock();
        }
        if (delta.content) {
          openBlock('text');
          res.write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: delta.content },
            })
          );
          closeBlock();
        }
        if (choice.finish_reason && !finished) {
          finished = true;
          res.write(
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null },
              usage: { output_tokens: 0 },
            })
          );
        }
      }
      if (!finished) {
        res.write(
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          })
        );
      }
      res.write(sse('message_stop', { type: 'message_stop' }));
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
      maxTokens,
    });
    const d = resp.json;
    const choice = d.choices && d.choices[0];
    const msg = (choice && choice.message) || {};
    const agg = {
      content: msg.content || '',
      reasoning: msg.reasoning_content || '',
      finishReason: (choice && choice.finish_reason) || null,
      usage: d.usage,
    };
    sendJson(res, 200, anthropicResponse(msgId, modelOut, agg));
  } catch (e) {
    sendError(res, e.statusCode || 502, e.code || 'LLM_FAILED', e.message);
  }
}

module.exports = { handleMessages, anthropicMessagesToOpenAI };
