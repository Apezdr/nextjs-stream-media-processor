/**
 * What every format's adapter shares: rejections, body decoding and the
 * plain JSON error shape. Pure.
 *
 * A rejection's reason is a fixed sentence, or names a field: never a value
 * from the request. V8's JSON.parse messages quote the body ("Unexpected
 * token 'o', "not json at"... is not valid JSON"), so they are never passed on.
 *
 * @typedef {{ ok: false, status: number, code: string, reason: string }} Rejection
 */

import { STATUS_CODES } from 'http';

/** @returns {Rejection} */
export function reject(status, code, reason) {
  return { ok: false, status, code, reason };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The body as UTF-8 text, or a rejection. */
export function bodyText(body) {
  try {
    return { ok: true, text: utf8.decode(body) };
  } catch {
    return reject(400, 'not-utf8', 'the body is not UTF-8 text');
  }
}

/** The body parsed as JSON, or a rejection with a fixed reason. */
export function bodyJson(body) {
  const decoded = bodyText(body);
  if (!decoded.ok) return decoded;
  try {
    return { ok: true, value: JSON.parse(decoded.text) };
  } catch {
    return reject(400, 'bad-json', 'the body is not valid JSON');
  }
}

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The plain JSON error body (alertmanager and generic). */
export function plainError(error) {
  return { error: STATUS_CODES[error.status] ?? 'Error', message: error.reason };
}

/** A header value Node decoded as latin1, read again as the UTF-8 its sender meant, when it is valid UTF-8. */
export function utf8Header(value) {
  if (typeof value !== 'string' || !/[\u0080-ÿ]/.test(value)) return value;
  try {
    return utf8.decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
}
