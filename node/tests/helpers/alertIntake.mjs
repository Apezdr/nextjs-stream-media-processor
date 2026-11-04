/**
 * Fixtures for the alert intake tests (tests/fixtures/alert-intake/): each is
 * a request as a real sender makes it. These turn one into what an adapter's
 * parse() reads, or into a fetch() against a mounted router.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'alert-intake');

/** A key of the recommended shape: 43 base64url characters. */
export const KEY = 'Wq3vB8nX0pLk2sT7yZr4uE9cH1mJ6dGf5aQoNbVxCiY';
export const OTHER_KEY = 'Zz9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gFeDcBa_-.Aa';

const fill = (text, key) => text.replaceAll('${KEY}', key).replaceAll('${BASIC_EMPTY_USER_KEY}', Buffer.from(`:${key}`).toString('base64'));

export function loadFixture(name, key = KEY) {
  return JSON.parse(fill(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'), key));
}

const bodyOf = (body) => (body === undefined || body === '' ? '' : typeof body === 'string' ? body : JSON.stringify(body));
const mediaType = (header) => (typeof header === 'string' ? header.split(';')[0].trim().toLowerCase() || null : null);

/**
 * The request an adapter's parse() gets for a fixture.
 * @param {string} name
 * @param {{ key?: string, route: string, params?: object, receivedAt?: number, mutate?: (request: object) => void }} options
 */
export function fixtureRequest(name, { key = KEY, route, params = {}, receivedAt = Date.parse('2026-11-04T09:15:00Z'), mutate } = {}) {
  const { request } = loadFixture(name, key);
  mutate?.(request);
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([header, value]) => [header.toLowerCase(), value]));
  return {
    method: request.method,
    route,
    params,
    query: request.query ?? {},
    headers,
    body: Buffer.from(bodyOf(request.body)),
    contentType: mediaType(headers['content-type']),
    receivedAt,
  };
}

/** A fixture's request as fetch() would send it to `baseUrl`. */
export function fixtureFetch(name, baseUrl, { key = KEY, mutate } = {}) {
  const { request } = loadFixture(name, key);
  mutate?.(request);
  const url = new URL(request.path, baseUrl);
  for (const [param, value] of Object.entries(request.query ?? {})) url.searchParams.set(param, value);
  const body = bodyOf(request.body);
  return fetch(url, { method: request.method, headers: request.headers, body: body === '' ? undefined : body });
}
