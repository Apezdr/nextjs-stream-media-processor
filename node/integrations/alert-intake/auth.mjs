/**
 * Where each format's senders put the key, and the comparison. Pure.
 *
 * Each format lists its credential sources in order (PLAN.md §4.2) and the
 * first one PRESENT decides: a wrong key there is a refusal, never a cue to
 * try the next place. Query-string keys exist only where the format's clients
 * send them: Gotify's ?token= and ntfy's ?auth=.
 */

import { createHash, timingSafeEqual } from 'crypto';

/** @typedef {'authorization' | 'bearer' | 'gotify-token' | 'gotify-header' | 'ntfy-auth'} CredentialSource */

/** A Basic credential's key: the password, or the username when the password is empty. */
function basicKey(encoded) {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const user = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
  return (pass || user).trim() || null;
}

/**
 * The key in an Authorization value. `schemes` says which it may be. null
 * when the value isn't a credential this source reads at all; `{ malformed }`
 * when it claims to be one but holds nothing usable.
 */
// Longer than any scheme and key we accept: refused before any parsing.
const MAX_AUTHORIZATION = 1024;

function fromAuthorization(value, schemes) {
  if (value.length > MAX_AUTHORIZATION) return { malformed: true };
  const match = /^(\S+)\s+(\S.*)$/.exec(value.trim());
  if (!match) return { malformed: true };
  const scheme = match[1].toLowerCase();
  if (scheme === 'bearer' && schemes.includes('bearer')) return { method: 'bearer', key: match[2].trim() };
  if (scheme === 'basic' && schemes.includes('basic')) {
    const key = basicKey(match[2].trim());
    return key ? { method: 'basic', key } : { malformed: true };
  }
  return schemes.length === 2 ? { malformed: true } : null;
}

/** One query parameter, or `{ malformed }` when it was given more than once. */
function queryValue(query, name) {
  const value = query?.[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') return { malformed: true };
  return value;
}

/**
 * The credential a request carries, read from the sources in order.
 * @param {{ headers: Record<string, string|string[]|undefined>, query: Record<string, unknown> }} request
 * @param {CredentialSource[]} sources
 * @returns {{ method: string, key: string } | { malformed: true } | null}
 */
export function readCredential(request, sources) {
  for (const source of sources) {
    const found = readOne(request, source);
    if (found) return found;
  }
  return null;
}

function readOne({ headers, query }, source) {
  switch (source) {
    case 'authorization': {
      const value = headers.authorization;
      return typeof value === 'string' && value !== '' ? fromAuthorization(value, ['bearer', 'basic']) : null;
    }
    case 'bearer': {
      // Gotify reads a Bearer token and ignores any other scheme.
      const value = headers.authorization;
      return typeof value === 'string' && value !== '' ? fromAuthorization(value, ['bearer']) : null;
    }
    case 'gotify-token': {
      const value = queryValue(query, 'token');
      if (value === null || typeof value === 'object') return value;
      return value === '' ? { malformed: true } : { method: 'query', key: value };
    }
    case 'gotify-header': {
      const value = headers['x-gotify-key'];
      return typeof value === 'string' && value !== '' ? { method: 'header', key: value.trim() } : null;
    }
    case 'ntfy-auth': {
      // ntfy's ?authorization= or ?auth= (read in that order, as ntfy's
      // readAuthHeader) is the whole Authorization value, base64url with the
      // padding stripped. Node's decoder takes either alphabet, with or
      // without padding. It wins over the header, as in ntfy.
      for (const name of ['authorization', 'auth']) {
        const value = queryValue(query, name);
        if (value === null) continue;
        if (typeof value === 'object' || value === '') return { malformed: true };
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        const found = fromAuthorization(decoded, ['bearer', 'basic']);
        return found?.key ? { method: `query-${found.method}`, key: found.key } : { malformed: true };
      }
      return null;
    }
    default:
      throw new Error(`unknown credential source ${JSON.stringify(source)}`);
  }
}

/**
 * A matcher over the configured keys' SHA-256 digests. Every key is compared
 * whichever matches, with timingSafeEqual on fixed-length digests, so the time
 * taken says nothing about which key matched, how many there are, or how long
 * the presented one was.
 * @param {{ source: string, digest: Buffer }[]} keys
 * @param {(a: Buffer, b: Buffer) => boolean} [equal] injectable for tests
 * @returns {(presented: string) => object | null} the matching entry
 */
export function createKeyMatcher(keys, equal = timingSafeEqual) {
  return function matchKey(presented) {
    const digest = createHash('sha256').update(String(presented), 'utf8').digest();
    let matched = null;
    for (const entry of keys) {
      const same = equal(digest, entry.digest);
      if (same && matched === null) matched = entry;
    }
    return matched;
  };
}
