/**
 * The admin Logs page's areas: every log category belongs to one, so the
 * page can hide or isolate a whole area ("Library scan") instead of a list of
 * 65 overlapping names (discordBot, discordBot:ready, discordIntegration,
 * discordIntro, discordIntros …). Category names are unchanged, in the files
 * and in SigNoz.
 *
 * Add a new createCategoryLogger() name here: tests/unit/lib/log-areas.test.mjs
 * fails for a category that would fall into "Other".
 */

export const LOG_AREAS = [
  {
    id: 'scan',
    label: 'Library scan',
    categories: [
      'movie-scanner', 'tv-scanner', 'scanner-controller', 'scanner-repository', 'scanProgress',
      'media-resolution', 'video-sources', 'infoFileManager', 'file-utils',
    ],
  },
  {
    id: 'metadata',
    label: 'Metadata & images',
    categories: [
      'metadata-generator', 'DownloadTMDBImages', 'image-downloader', 'tmdb-api', 'tmdb-config', 'tmdb-utils',
      'tmdb-blurhash', 'tmdb-blurhash-cache', 'backdrop-focal', 'blurhash-native', 'blurhash-pool',
      'blurhash-worker', 'metadataHashes', 'metadataHashesRoutes', 'metadataUrlHash',
      'python:GeneratePosterCollage',
    ],
  },
  { id: 'identity', label: 'Identity (Radarr/Sonarr)', categories: ['identity', 'identity-routes', 'media-identity'] },
  {
    id: 'video',
    label: 'Video processing',
    categories: [
      'ffmpeg', 'ffprobe', 'mediaInfo', 'dolby-vision', 'chapter-generator', 'clip-encode', 'sprite', 'sprite-route',
      'videoHandler', 'range-file',
    ],
  },
  { id: 'captions', label: 'Captions', categories: ['caption-config', 'caption-controller', 'captions-routes', 'whisper'] },
  {
    id: 'discord',
    label: 'Discord & notifications',
    categories: [
      'discordBot', 'discordBotStarter', 'discordIntegration', 'discordIntro', 'discordIntros', 'discordWebhookEvents',
      'notificationManager',
    ],
    prefixes: ['discordBot:'],
  },
  { id: 'auth', label: 'Auth & sessions', categories: ['auth-middleware', 'webhook-auth', 'session-cache'] },
  {
    id: 'system',
    label: 'System',
    categories: [
      'main', 'mongoDB', 'taskManager', 'processTracking', 'systemStatusRoutes', 'telemetry', 'utility', 'admin-routes',
      'logs-route', 'logger',
    ],
  },
];

/** Categories in no area, and lines with no category at all. */
export const OTHER_AREA = { id: 'other', label: 'Other' };

const AREA_IDS = new Set([...LOG_AREAS.map((area) => area.id), OTHER_AREA.id]);
const AREA_BY_CATEGORY = new Map(LOG_AREAS.flatMap((area) => area.categories.map((category) => [category, area.id])));

export function isLogArea(id) {
  return AREA_IDS.has(id);
}

/** @param {string | null} category */
export function areaOf(category) {
  if (!category) return OTHER_AREA.id;
  const exact = AREA_BY_CATEGORY.get(category);
  if (exact) return exact;
  const byPrefix = LOG_AREAS.find((area) => area.prefixes?.some((prefix) => category.startsWith(prefix)));
  return byPrefix ? byPrefix.id : OTHER_AREA.id;
}

/** The areas in page order, for labels; "Other" last. */
export function listLogAreas() {
  return [...LOG_AREAS.map(({ id, label }) => ({ id, label })), OTHER_AREA];
}
