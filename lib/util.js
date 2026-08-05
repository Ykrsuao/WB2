'use strict';

/**
 * Small shared helpers: SSE framing, JSON body parsing, UUIDs, HTTP helpers.
 */

function uuid() {
  // RFC4122 v4
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** SSE frame writer. Returns a string you can write() to the response. */
function sse(event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/** Extract JSON payload from an SSE `data:` line (raw line without prefix). */
function parseSseData(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Read the full request body as a string. */
function readBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse JSON body; throws with a friendly message on failure. */
async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

module.exports = { uuid, sse, parseSseData, readBody, readJsonBody, sendJson, sendError };
