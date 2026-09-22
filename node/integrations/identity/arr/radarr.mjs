/**
 * Radarr identity provider. Env: RADARR_URL, RADARR_API_KEY, optional
 * RADARR_ROOT_MAP and RADARR_TIMEOUT_MS (see arrProvider.mjs).
 *
 * List: GET /api/v3/movie → [{ id, title, year, path, tmdbId, imdbId, hasFile, … }]
 * Webhook subject: body.movie → { id, title, year, folderPath, tmdbId, imdbId }
 */

import { ArrProvider, readArrEnv } from './arrProvider.mjs';
import { EVENT_KINDS } from '../provider.mjs';

const RADARR_EVENT_KINDS = Object.freeze({
  MovieAdded: EVENT_KINDS.ADDED,
  MovieDelete: EVENT_KINDS.DELETED,
  MovieFileDelete: EVENT_KINDS.FILE_DELETED,
});

export class RadarrProvider extends ArrProvider {
  static get providerName() {
    return 'radarr';
  }

  static get envPrefix() {
    return 'RADARR';
  }

  static fromEnv(env, deps = {}) {
    const cfg = readArrEnv(env, RadarrProvider.envPrefix);
    if (!cfg) return null;
    return new RadarrProvider({ ...cfg, fetchImpl: deps.fetchImpl, logger: deps.logger });
  }

  constructor(options) {
    super({ ...options, name: RadarrProvider.providerName, mediaType: 'movie' });
  }

  get listEndpoint() {
    return '/api/v3/movie';
  }

  get webhookSubjectKey() {
    return 'movie';
  }

  get eventKinds() {
    return { ...super.eventKinds, ...RADARR_EVENT_KINDS };
  }

  itemHasFile(item) {
    return typeof item?.hasFile === 'boolean' ? item.hasFile : null;
  }

  webhookSubjectPath(subject) {
    return subject?.folderPath ?? subject?.path ?? null;
  }
}
