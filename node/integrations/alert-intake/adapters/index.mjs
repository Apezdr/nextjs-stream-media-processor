/**
 * The formats the intake reads, by name. Each adapter is pure: a request in
 * (never the Express req), normalized alerts or a typed rejection out, and
 * the reply shapes its clients expect.
 *
 *   name            the path segment under /api/alert-intake and the format name in logs
 *   routes          [{ methods, path, route }] relative to /api/alert-intake
 *   credentials     where its senders put the key, in order (auth.mjs)
 *   bodyLimitBytes  read after the key matched
 *   parse(request)  → { ok: true, alerts, context } | { ok: false, status, code, reason }
 *   reply(outcome, context, { sourceIndex, nextId, now }) → { status, body }
 *   replyError({ status, code, reason }) → { status, body }
 *
 * v1.1 adds Apprise JSON and the Slack- and Discord-compatible formats here.
 * Those senders take only a URL, so their key rides in the path, which needs
 * a scrub rule in lib/spanRedaction.mjs and the logs before they ship.
 */

import { alertmanager } from './alertmanager.mjs';
import { generic } from './generic.mjs';
import { gotify } from './gotify.mjs';
import { ntfy } from './ntfy.mjs';

export const ADAPTERS = Object.freeze({ generic, alertmanager, gotify, ntfy });
