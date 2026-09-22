/**
 * Sonarr identity provider. Env: SONARR_URL, SONARR_API_KEY, optional
 * SONARR_ROOT_MAP and SONARR_TIMEOUT_MS (see arrProvider.mjs).
 *
 * List: GET /api/v3/series → [{ id, title, year, path, tmdbId, tvdbId, imdbId,
 *       statistics: { episodeFileCount, … }, … }]
 * Webhook subject: body.series → { id, title, year, path, tmdbId, tvdbId, imdbId }
 *
 * Sonarr 4 publishes `tmdbId` directly on the series, so no TVDB→TMDB
 * translation is needed. The tvdb id is carried as an external id for later.
 */

import { ArrProvider, readArrEnv } from './arrProvider.mjs';
import { EVENT_KINDS } from '../provider.mjs';

const SONARR_EVENT_KINDS = Object.freeze({
  SeriesAdd: EVENT_KINDS.ADDED,
  SeriesDelete: EVENT_KINDS.DELETED,
  EpisodeFileDelete: EVENT_KINDS.FILE_DELETED,
});

export class SonarrProvider extends ArrProvider {
  static get providerName() {
    return 'sonarr';
  }

  static get envPrefix() {
    return 'SONARR';
  }

  static fromEnv(env, deps = {}) {
    const cfg = readArrEnv(env, SonarrProvider.envPrefix);
    if (!cfg) return null;
    return new SonarrProvider({ ...cfg, fetchImpl: deps.fetchImpl, logger: deps.logger });
  }

  constructor(options) {
    super({ ...options, name: SonarrProvider.providerName, mediaType: 'tv' });
  }

  get listEndpoint() {
    return '/api/v3/series';
  }

  get webhookSubjectKey() {
    return 'series';
  }

  get eventKinds() {
    return { ...super.eventKinds, ...SONARR_EVENT_KINDS };
  }

  itemHasFile(item) {
    const count = item?.statistics?.episodeFileCount;
    return Number.isInteger(count) ? count > 0 : null;
  }

  itemExternalIds(item) {
    const ids = super.itemExternalIds(item);
    if (item?.tvdbId) ids.tvdb = item.tvdbId;
    return ids;
  }

  /** A series is obtainable once it is no longer `upcoming` (continuing or ended). */
  itemReleased(item) {
    const status = this.itemArrStatus(item);
    return status ? status !== 'upcoming' : null;
  }
}
