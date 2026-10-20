/**
 * Masks secret-shaped values that no specific redaction knew about: a key in
 * a query string (?apikey=…, &token=…), a Bearer token, or a field named like
 * a credential (authorization, apiKey, password …). The *arr feed URLs and
 * the webhook ID both reached the logs before anyone noticed; this catches
 * the next one, and marks the record (SECRETS_MASKED) so the "secret in a log
 * line" alert can name the log call to fix.
 */

import { mapRecordStrings } from './recordWalk.mjs';

export const SECRETS_MASKED = Symbol('secrets masked');

const MASK = '[masked]';
const QUERY_SECRET = /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|passwd|signature)=)([^&\s"'<>#]+)/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9\-._~+/]{16,}=*)/g;
const SECRET_FIELD = /^(?:authorization|x-api-key|api[_-]?key|access[_-]?token|password|passwd|secret|client[_-]?secret)$/i;

// A value some earlier redaction already took care of.
const alreadyHidden = (value) =>
  /^(?:\[(?:masked|redacted)\]|\*+|redacted)$/i.test(value) || value.startsWith('[webhook-id ');

/** Masks the secrets in `info` in place (copy on write below the top level); returns the kinds found. */
export function maskSecrets(info) {
  const found = new Set();
  mapRecordStrings(info, (text, key) => {
    if (key && SECRET_FIELD.test(key) && text.length > 0 && !alreadyHidden(text)) {
      found.add('field');
      return MASK;
    }
    return text
      .replace(QUERY_SECRET, (match, prefix, value) => {
        if (alreadyHidden(value)) return match;
        found.add('query');
        return `${prefix}${MASK}`;
      })
      .replace(BEARER, (match, prefix) => {
        found.add('bearer');
        return `${prefix}${MASK}`;
      });
  });
  if (found.size > 0) info[SECRETS_MASKED] = [...found];
  return info;
}
