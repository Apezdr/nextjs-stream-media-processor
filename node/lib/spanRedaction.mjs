/**
 * Keeps credentials sent in a URL out of the trace store. The HTTP and undici
 * instrumentations record each URL as the span starts: url.full on a client
 * span (every TMDB call carries ?api_key=), url.path and url.query on a server
 * span. This rewrites them, and a span name holding a URL, before anything is
 * exported. The nextjs-stream app runs the same rules (src/lib/telemetrySpans.ts).
 */

// Query parameters that carry a credential, compared lowercased with - _ .
// removed: apikey matches apiKey, api_key and api-key. code and user_code are
// the one-time codes of a sign-in callback and the device flow; the signature
// names are signed cloud URLs'.
const CREDENTIAL_PARAMS = new Set([
  'apikey',
  'key',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'xplextoken',
  'jwt',
  'webhookid',
  'auth',
  // ntfy reads ?authorization= as well as ?auth= (alert intake)
  'authorization',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'code',
  'usercode',
  'sig',
  'signature',
  'xamzsignature',
  'xamzcredential',
  'xamzsecuritytoken',
  'xgoogsignature',
  'awsaccesskeyid',
]);

// url.query has no leading '?'. http.url and http.target are the older HTTP
// conventions, still emitted under OTEL_SEMCONV_STABILITY_OPT_IN=http/dup.
const URL_ATTRIBUTES = ['url.full', 'url.path', 'url.query', 'http.url', 'http.target'];

// Linear on any input: neither class can cross the separator that starts the
// next match, and the scheme is bounded (an unbounded one backtracks over a
// long run like a.a.a.a://).
const QUERY_PARAM = /([?&;])([^=&#?;\s]+)=([^&#?;\s]*)/g;
const USERINFO = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]+:[^\s/@]*@/gi;
// A Discord webhook's token is the last path segment, not a parameter
const DISCORD_WEBHOOK_TOKEN = /(\/api\/webhooks\/\d+\/)[\w-]+/g;

function isCredentialParam(name) {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // a malformed escape is compared as sent
  }
  return CREDENTIAL_PARAMS.has(decoded.toLowerCase().replace(/[-_.]/g, ''));
}

/**
 * A URL, or text holding one, with every credential in it replaced by
 * REDACTED: credential query parameters' values, a user:password, a Discord
 * webhook token. Everything else is kept.
 */
export function redactUrlCredentials(text) {
  let result = text;
  if (result.includes('=')) {
    result = result.replace(QUERY_PARAM, (match, separator, name, value) =>
      value && isCredentialParam(name) ? `${separator}${name}=REDACTED` : match
    );
  }
  if (result.includes('@')) result = result.replace(USERINFO, '$1REDACTED@');
  if (result.includes('/api/webhooks/')) result = result.replace(DISCORD_WEBHOOK_TOKEN, '$1REDACTED');
  return result;
}

export const credentialSpanProcessor = {
  onStart(span) {
    for (const key of URL_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value !== 'string') continue;
      const redacted = key === 'url.query' ? redactUrlCredentials(`?${value}`).slice(1) : redactUrlCredentials(value);
      if (redacted !== value) span.setAttribute(key, redacted);
    }
    const redactedName = redactUrlCredentials(span.name);
    if (redactedName !== span.name) span.updateName(redactedName);
  },
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
