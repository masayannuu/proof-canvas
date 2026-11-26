// Embedded board payload codec shared by the renderer and the validator.
// Small boards embed plain JSON (readable in view-source). Large boards embed
// gzip + standard base64, decoded in the browser by the built-in DecompressionStream:
// zero dependencies on both sides (node:zlib / web platform). The browser runtime in
// render_board.mjs applies the same base64 rule and the same two size limits.

import { gunzipSync, gzipSync } from 'node:zlib';

export const DATA_ELEMENT_ID = 'proof-canvas-data';
export const ROOT_ELEMENT_ID = 'proof-canvas-root';
export const JSON_TYPE = 'application/json';
export const GZIP_TYPE = 'application/x-proof-canvas+gzip';
export const PAYLOAD_MODES = ['auto', 'json', 'gzip'];
// Raw JSON above this size is compressed in `auto` mode.
export const AUTO_GZIP_THRESHOLD = 192 * 1024;
// The embedded text is checked against this limit before any decoding.
export const MAX_PAYLOAD_TEXT_BYTES = 512 * 1024;
// Inflated JSON may not exceed this many bytes (guards against decompression bombs).
export const MAX_DECODED_BYTES = 4 * 1024 * 1024;
// Strict standard base64 (RFC 4648 section 4): no URL-safe alphabet, padding required.
export const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const safeJsonEmbed = (obj) =>
  JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export function encodePayload(obj, mode = 'auto') {
  if (!PAYLOAD_MODES.includes(mode)) throw new Error(`Invalid payload mode "${mode}" (expected ${PAYLOAD_MODES.join(', ')})`);
  const plain = JSON.stringify(obj);
  const plainBytes = Buffer.byteLength(plain, 'utf8');
  if (plainBytes > MAX_DECODED_BYTES) throw new Error(`board JSON is ${plainBytes} bytes; the limit is ${MAX_DECODED_BYTES} bytes`);
  const json = safeJsonEmbed(obj);
  const rawBytes = Buffer.byteLength(json, 'utf8');
  const useGzip = mode === 'gzip' || (mode === 'auto' && rawBytes > AUTO_GZIP_THRESHOLD);
  if (!useGzip) return { type: JSON_TYPE, text: json, rawBytes, embeddedBytes: rawBytes };
  const text = gzipSync(Buffer.from(plain, 'utf8'), { level: 9 }).toString('base64');
  return { type: GZIP_TYPE, text, rawBytes, embeddedBytes: text.length };
}

export function decodePayload(type, text) {
  const outer = Buffer.byteLength(text, 'utf8');
  if (outer >= MAX_PAYLOAD_TEXT_BYTES) throw new Error(`payload text is ${outer} bytes; the limit is ${MAX_PAYLOAD_TEXT_BYTES} bytes`);
  if (type === JSON_TYPE) return JSON.parse(text);
  if (type === GZIP_TYPE) {
    const b64 = text.trim();
    if (!BASE64_RE.test(b64)) throw new Error('gzip payload is not strict standard base64');
    let inflated;
    try {
      inflated = gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: MAX_DECODED_BYTES });
    } catch (e) {
      if (e instanceof RangeError || e?.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`gzip payload inflates beyond ${MAX_DECODED_BYTES} bytes`);
      throw e;
    }
    return JSON.parse(inflated.toString('utf8'));
  }
  throw new Error(`unknown payload type "${type}" (expected ${JSON_TYPE} or ${GZIP_TYPE})`);
}

const PAYLOAD_RE = new RegExp(`<script\\b([^>]*)\\bid\\s*=\\s*["']?${DATA_ELEMENT_ID}["']?([^>]*)>([\\s\\S]*?)</script\\s*>`, 'gi');

// Every embedded payload element, as [{ type, text }]. A valid board has exactly one.
export function findPayloads(html) {
  return [...html.matchAll(PAYLOAD_RE)].map((m) => {
    const t = `${m[1]} ${m[2]}`.match(/\btype\s*=\s*["']([^"']+)["']/i);
    return { type: t ? t[1] : '', text: m[3] };
  });
}

// The HTML with every payload element removed (so its data is never scanned as markup).
export function stripPayloads(html) {
  return html.replace(PAYLOAD_RE, '');
}
