import axios from "axios";
import pLimit from "p-limit";
import { createCategoryLogger } from "../lib/logger.mjs";
import { withApiRequestSpan, withApiCacheSpan } from "../lib/apiTracer.mjs";
import { getTmdbCache, getTmdbCacheEntryAnyAge, setTmdbCache, withWriteTx } from "../sqliteDatabase.mjs";
import {
  enhanceTmdbResponseWithBlurhash,
  generateBlurhashCacheKey,
} from "./tmdbBlurhash.mjs";

const logger = createCategoryLogger("tmdb-utils");

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// One TMDB-wide concurrency ceiling (T-4b): the limiter wraps the HTTP call
// inside makeTmdbRequest, so every caller — scanner, admin routes,
// user-facing routes — draws from the same budget and no future caller can
// reintroduce an unbounded fan-out. Cache hits never touch the limiter.
const tmdbRequestLimit = pLimit(Number(process.env.TMDB_REQUEST_CONCURRENCY || 8));

// Per-collection fan-out cap (T-4a) for the parts[] detail fetches below —
// layered under the global ceiling so one big collection can't monopolize it.
const COLLECTION_FANOUT_CONCURRENCY = 5;

// Preferred metadata language for episode title/overview. TMDB's episode `name`
// is the base/primary name and (for English-original shows) is NOT overridden by
// the per-language translation the TMDB website displays — so an episode can read
// e.g. "Che Guevara" from the episode endpoint while the site (and the
// `translations` sub-resource) show the en-US title "New York in June". When set,
// getEpisodeDetails fetches translations and prefers that language's name/overview.
// Set TMDB_PREFERRED_LANGUAGE='' to disable and use TMDB's base fields verbatim.
const PREFERRED_METADATA_LANGUAGE = (process.env.TMDB_PREFERRED_LANGUAGE ?? "en-US").trim();

if (!TMDB_API_KEY) {
  logger.error("TMDB_API_KEY environment variable is not set");
}

/**
 * A TMDB name search legitimately returned zero results — the title has no
 * match, as opposed to a network/HTTP/rate-limit failure (those stay generic
 * Errors). Lets MetadataGenerator classify the failure in its return contract
 * (`reason: 'no-match'` vs `'transient-error'`). Note the scanners currently
 * apply the same 24h cooldown to both reasons — the type exists so the two
 * cases stop being indistinguishable at the contract/log layer, not because
 * they are paced differently today.
 */
export class TmdbNoMatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "TmdbNoMatchError";
    this.code = "no-match";
  }
}

/**
 * Helper function to make TMDB API requests with caching and retry logic
 * @param {string} endpoint - TMDB API endpoint (e.g., '/search/movie')
 * @param {Object} params - Query parameters
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} cacheTtlHours - Cache TTL in hours (default: 1440 = 60 days)
 * @param {boolean} forceRefresh - Force refresh cache (default: false)
 * @param {boolean} includeBlurhash - Include blurhash data for images (default: false)
 * @param {string|null} ifNoneMatch - ETag for conditional request (If-None-Match header)
 * @returns {Promise<Object>} TMDB API response data with ETag support
 */
export const makeTmdbRequest = async (
  endpoint,
  params = {},
  maxRetries = 3,
  cacheTtlHours = 1440,
  forceRefresh = false,
  includeBlurhash = false,
  ifNoneMatch = null,
) => {
  // Clean up expired cache entries periodically (10% chance)
  // Fire and forget to avoid blocking
  if (Math.random() < 0.1) {
    withWriteTx("tmdbCache", async (db) => {
      const now = new Date().toISOString();
      const result = await db.run(
        "DELETE FROM tmdb_cache WHERE expires_at <= ?",
        [now],
      );
      const deletedCount = result.changes || 0;
      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} expired TMDB cache entries`);
      }
    }).catch((err) => {
      logger.warn(`Failed to clean expired cache: ${err.message}`);
    });
  }

  // Generate a special cache key for blurhash-enhanced responses
  const cacheKey = generateBlurhashCacheKey(endpoint, params, includeBlurhash);

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = await withApiCacheSpan(
      {
        service: "tmdb",
        operation: "GET",
        cacheKey: cacheKey,
        endpoint: endpoint,
      },
      async () => {
        return await getTmdbCache(endpoint, params, cacheKey);
      },
    );

    if (cached) {
      logger.debug(
        `TMDB cache hit for ${endpoint}${includeBlurhash ? " with blurhash" : ""}`,
      );
      return {
        ...cached.data,
        _cached: true,
        _cachedAt: cached.cachedAt,
        _expiresAt: cached.expiresAt,
      };
    }
  }

  // Conditional revalidation (T-1): we're about to refetch — either the row
  // expired or forceRefresh skipped the read. If the caller didn't supply an
  // If-None-Match, ride the stored ETag out so TMDB can answer 304 instead of
  // shipping the payload; the 304 branch below then re-ups the stored row.
  let staleEntry = null;
  if (!ifNoneMatch) {
    staleEntry = await getTmdbCacheEntryAnyAge(endpoint, params, cacheKey);
    if (staleEntry?.etag) {
      ifNoneMatch = staleEntry.etag;
    }
  }

  // Make API request with retry logic and ETag support
  let retries = 0;
  let backoffFactor = 1;
  let responseData;
  let responseETag = null;

  while (retries < maxRetries) {
    try {
      const headers = {};

      // Add If-None-Match header for ETag validation if provided
      if (ifNoneMatch) {
        headers["If-None-Match"] = ifNoneMatch;
        logger.debug(`Using ETag validation for ${endpoint}: ${ifNoneMatch}`);
      }

      // Each attempt takes one slot from the shared TMDB-wide ceiling
      // (T-4b); queued retries requeue fairly behind other callers.
      const response = await tmdbRequestLimit(() =>
        withApiRequestSpan(
          {
            service: "tmdb",
            method: "GET",
            url: `${TMDB_BASE_URL}${endpoint}`,
            endpoint: endpoint,
            params: params,
            cacheKey: cacheKey,
          },
          async () => {
            return await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
              params: {
                api_key: TMDB_API_KEY,
                ...params,
              },
              headers,
              timeout: 10000,
              validateStatus: (status) => {
                // Accept both 200 (OK) and 304 (Not Modified) as valid responses
                return status === 200 || status === 304;
              },
            });
          },
        ),
      );

      // Handle 304 Not Modified response
      if (response.status === 304) {
        logger.debug(
          `TMDB returned 304 Not Modified for ${endpoint} - content unchanged`,
        );
        // The stored row (typically expired — that's why we refetched) is
        // confirmed current: re-up its TTL under the same ETag and return it
        // without a payload transfer (T-1).
        const validated =
          staleEntry || (await getTmdbCacheEntryAnyAge(endpoint, params, cacheKey));
        if (validated) {
          await withApiCacheSpan(
            {
              service: "tmdb",
              operation: "SET",
              cacheKey: cacheKey,
              ttl: cacheTtlHours,
              endpoint: endpoint,
            },
            async () =>
              setTmdbCache(
                endpoint,
                params,
                validated.data,
                cacheTtlHours,
                cacheKey,
                ifNoneMatch || validated.etag,
              ),
          );
          return {
            ...validated.data,
            _cached: true,
            _cachedAt: validated.cachedAt,
            _expiresAt: validated.expiresAt,
            _notModified: true,
          };
        }
        // If no cached data available, fall through to treat as error
        logger.warn(`Received 304 but no cached data found for ${endpoint}`);
      }

      responseData = response.data;
      responseETag = response.headers.etag || response.headers.ETag;
      break;
    } catch (error) {
      if (error.response?.status === 429) {
        // Rate limited by TMDB
        const retryAfter =
          parseInt(error.response.headers["retry-after"]) || backoffFactor;
        logger.warn(
          `TMDB rate limit hit, waiting ${retryAfter}s before retry ${retries + 1}/${maxRetries}`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        retries++;
        backoffFactor *= 2;
      } else if (
        error.code === "ECONNABORTED" ||
        error.code === "ENOTFOUND" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET" ||
        (error.response?.status >= 500 && error.response?.status <= 599)
      ) {
        // Transient network/server error (T-5): connection-level failures and
        // TMDB 5xx responses back off and retry like timeouts always did.
        logger.warn(
          `Transient TMDB error for ${endpoint} (${error.response?.status || error.code}), retry ${retries + 1}/${maxRetries}: ${error.message}`,
        );
        retries++;
        await new Promise((resolve) =>
          setTimeout(resolve, backoffFactor * 1000),
        );
        backoffFactor *= 2;
      } else {
        logger.error(`TMDB API error for ${endpoint}:`, error.message);
        throw new Error(`TMDB API request failed: ${error.message}`);
      }
    }
  }

  if (!responseData) {
    throw new Error(`TMDB API request failed after ${maxRetries} retries`);
  }

  // If blurhash is requested, enhance the response with blurhash data
  // IMPORTANT: Only enhance BEFORE caching, not on retrieval
  if (includeBlurhash) {
    responseData = await withApiRequestSpan({
      service: 'tmdb',
      method: 'PROCESS',
      endpoint: 'blurhash-enhance',
      params: { endpoint }
    }, async () => {
      return await enhanceTmdbResponseWithBlurhash(
        responseData,
        endpoint,
      );
    });
  }

  // Cache the ENHANCED response with ETag (so we don't enhance it again on retrieval)
  await withApiCacheSpan({
    service: 'tmdb',
    operation: 'SET',
    cacheKey: cacheKey,
    ttl: cacheTtlHours,
    endpoint: endpoint
  }, async () => {
    return await setTmdbCache(
      endpoint,
      params,
      responseData,
      cacheTtlHours,
      cacheKey,
      responseETag,
    );
  });
  logger.debug(
    `TMDB response cached for ${endpoint}${includeBlurhash ? " with blurhash" : ""}${responseETag ? " with ETag" : ""}`,
  );

  return {
    ...responseData,
    _cached: false,
    _cachedAt: new Date().toISOString(),
    _etag: responseETag,
  };
};

/**
 * Search for movies or TV shows
 * @param {string} type - 'movie' or 'tv'
 * @param {string} query - Search query
 * @param {number} page - Page number (default: 1)
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Search results
 */
export const searchMedia = async (
  type,
  query,
  page = 1,
  includeBlurhash = false,
) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  if (!query) {
    throw new Error("Query parameter is required");
  }

  return await makeTmdbRequest(
    `/search/${type}`,
    { query, page },
    3,
    1440,
    false,
    includeBlurhash,
  );
};

/**
 * Get detailed information for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Media details with last_updated timestamp
 */
export const getMediaDetails = async (type, id, includeBlurhash = false) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  const data = await makeTmdbRequest(
    `/${type}/${id}`,
    {},
    3,
    1440,
    false,
    includeBlurhash,
  );

  // Add last updated timestamp like the Python script
  data.last_updated = new Date().toISOString();

  return data;
};

/**
 * Get cast information for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Array>} Formatted cast array
 */
export const getMediaCast = async (type, id) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  const data = await makeTmdbRequest(`/${type}/${id}/credits`);

  // Format cast data similar to Python script
  return (
    data.cast?.map((member) => ({
      id: member.id,
      name: member.name,
      character: member.character || "",
      profile_path: member.profile_path
        ? `https://image.tmdb.org/t/p/original${member.profile_path}`
        : null,
    })) || []
  );
};

/**
 * Get enhanced cast information with Season Regulars support for TV shows
 * For movies, returns same data as getMediaCast. For TV shows, uses aggregate_credits
 * to include episode counts and role classifications
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Array>} Enhanced cast array with role data for TV shows
 */
export const getEnhancedMediaCast = async (type, id) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  if (type === "tv") {
    // Use aggregate_credits for TV shows to get Season Regulars data
    const data = await makeTmdbRequest(`/tv/${id}/aggregate_credits`);
    return formatAggregateCast(data.cast);
  } else {
    // For movies, use regular credits endpoint
    const data = await makeTmdbRequest(`/movie/${id}/credits`);
    return formatBasicCast(data.cast);
  }
};

/**
 * Format aggregate credits cast data (TV shows)
 * @param {Array} castData - Raw aggregate credits cast data from TMDB
 * @returns {Array} Formatted cast array with enhanced TV data
 */
function formatAggregateCast(castData) {
  return (
    castData?.map((member) => ({
      id: member.id,
      name: member.name,
      character: member.roles?.[0]?.character || "",
      profile_path: member.profile_path
        ? `https://image.tmdb.org/t/p/original${member.profile_path}`
        : null,
      // Enhanced TV data
      roles: member.roles || [],
      total_episode_count: member.total_episode_count || 0,
      type: classifyRole(member.total_episode_count),
      known_for_department: member.known_for_department,
    })) || []
  );
}

/**
 * Format basic credits cast data (Movies)
 * @param {Array} castData - Raw credits cast data from TMDB
 * @returns {Array} Formatted cast array
 */
function formatBasicCast(castData) {
  return (
    castData?.map((member) => ({
      id: member.id,
      name: member.name,
      character: member.character || "",
      profile_path: member.profile_path
        ? `https://image.tmdb.org/t/p/original${member.profile_path}`
        : null,
    })) || []
  );
}

/**
 * Classify role type based on episode count for TV shows
 * @param {number} episodeCount - Number of episodes appeared in
 * @returns {string} Role classification
 */
function classifyRole(episodeCount) {
  if (!episodeCount || episodeCount <= 0) {
    return "Guest Star";
  }

  // Classification thresholds (can be adjusted based on analysis)
  if (episodeCount >= 8) {
    return "Season Regular";
  }

  if (episodeCount >= 3) {
    return "Recurring";
  }

  return "Guest Star";
}

/**
 * Get structured cast information with separated recurring cast for TV shows
 * Returns main cast array (all cast) plus recurring_cast array for TV shows
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @param {boolean} includeGuestCast - Include guest_cast array (default: false)
 * @returns {Promise<Object>} Object with cast (all), recurring_cast (TV only, 3-7 eps), and optionally guest_cast (TV only, <3 eps)
 */
export const getStructuredMediaCast = async (
  type,
  id,
  includeGuestCast = false,
) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  if (type === "movie") {
    // For movies, return all cast in the cast field (no separation)
    const cast = await getMediaCast(type, id);
    return { cast };
  }

  // For TV shows, use aggregate_credits to get episode counts
  const data = await makeTmdbRequest(`/tv/${id}/aggregate_credits`);
  const allCast = formatAggregateCast(data.cast);

  // The cast array contains ALL cast members (unchanged for backward compatibility)
  // But we also extract recurring and optionally guest cast into separate arrays
  const cast = allCast; // All cast members
  const recurring_cast = allCast.filter(
    (member) => member.type === "Recurring",
  );

  // Build result object
  const result = {
    cast, // All cast members (Season Regulars + Recurring + Guest Stars)
    recurring_cast, // Only recurring cast (3-7 episodes)
  };

  // Optionally include guest cast array
  if (includeGuestCast) {
    result.guest_cast = allCast.filter(
      (member) => member.type === "Guest Star",
    );
  }

  return result;
};

/**
 * Get videos/trailers for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Object>} Videos data with trailer_url
 */
export const getMediaVideos = async (type, id) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  const data = await makeTmdbRequest(`/${type}/${id}/videos`);

  // Find YouTube trailer (matching Python script logic)
  const trailer = data.results?.find(
    (video) => video.type === "Trailer" && video.site === "YouTube",
  );

  const trailerUrl = trailer
    ? `https://www.youtube.com/watch?v=${trailer.key}`
    : null;

  return {
    trailer_url: trailerUrl,
    videos: data.results || [],
  };
};

/**
 * Get images for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Images data with logo_path
 */
export const getMediaImages = async (type, id, includeBlurhash = false) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  const data = await makeTmdbRequest(
    `/${type}/${id}/images`,
    {
      include_image_language: "en,null",
    },
    3,
    1440,
    false,
    includeBlurhash,
  );

  // Find English logo (matching Python script logic)
  const logo = data.logos?.find((image) => image.iso_639_1 === "en");
  const logoPath = logo
    ? `https://image.tmdb.org/t/p/original${logo.file_path}`
    : null;

  return {
    logo_path: logoPath,
    backdrops: data.backdrops || [],
    posters: data.posters || [],
    logos: data.logos || [],
  };
};

/**
 * Get content rating for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Object>} Rating data
 */
export const getMediaRating = async (type, id) => {
  if (!["movie", "tv"].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }

  const endpoint = type === "movie" ? "release_dates" : "content_ratings";
  const data = await makeTmdbRequest(`/${type}/${id}/${endpoint}`);

  let rating = null;

  // Match Python script logic for rating extraction
  if (type === "movie" && data.results) {
    const usRelease = data.results.find(
      (country) => country.iso_3166_1 === "US",
    );
    const certifiedRelease = usRelease?.release_dates?.find(
      (release) => release.certification,
    );
    rating = certifiedRelease?.certification || null;
  } else if (type === "tv" && data.results) {
    const usRating = data.results.find(
      (ratingInfo) => ratingInfo.iso_3166_1 === "US",
    );
    rating = usRating?.rating || null;
  }

  return { rating };
};

/**
 * Get TV episode details
 * @param {string|number} showId - TMDB show ID
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @returns {Promise<Object>} Episode details with last_updated timestamp
 */
export const getEpisodeDetails = async (showId, season, episode, opts = {}) => {
  const { forceRefresh = false } = opts;

  const data = await makeTmdbRequest(
    `/tv/${showId}/season/${season}/episode/${episode}`,
    // Pull translations alongside so we can prefer the configured language's
    // title/overview (what the TMDB website shows) over the base `name`.
    PREFERRED_METADATA_LANGUAGE ? { append_to_response: "translations" } : {},
    3,            // maxRetries
    1440,         // cacheTtlHours
    // forceRefresh bypasses the 60-day response cache — critical for the
    // backfill, whose whole purpose is to detect TMDB fill-ins the cache hides.
    forceRefresh,
  );

  if (!data) return data;

  // Prefer the configured language's translation for name/overview, falling back
  // to the base fields when a translated value is absent/empty. Matches the title
  // shown on themoviedb.org for English-original shows where the base `name` and
  // the en-US translation diverge.
  if (PREFERRED_METADATA_LANGUAGE && data.translations?.translations) {
    const want = PREFERRED_METADATA_LANGUAGE.toLowerCase();
    const lang = want.split("-")[0];
    const t =
      data.translations.translations.find(
        (x) => `${x.iso_639_1}-${x.iso_3166_1}`.toLowerCase() === want,
      ) ||
      data.translations.translations.find((x) => (x.iso_639_1 || "").toLowerCase() === lang);
    if (t?.data?.name) data.name = t.data.name;
    if (t?.data?.overview) data.overview = t.data.overview;
  }
  // Never persist the bulky translations sub-resource into the episode file.
  delete data.translations;

  // Add last updated timestamp like Python script
  data.last_updated = new Date().toISOString();

  return data;
};

/**
 * Get TV episode images
 * @param {string|number} showId - TMDB show ID
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Episode images with thumbnail_url
 */
export const getEpisodeImages = async (
  showId,
  season,
  episode,
  includeBlurhash = false,
) => {
  const data = await makeTmdbRequest(
    `/tv/${showId}/season/${season}/episode/${episode}/images`,
    {},
    3,
    1440,
    false,
    includeBlurhash,
  );

  const thumbnailUrl = data.stills?.[0]?.file_path
    ? `https://image.tmdb.org/t/p/original${data.stills[0].file_path}`
    : null;

  return {
    thumbnail_url: thumbnailUrl,
    stills: data.stills || [],
  };
};

/**
 * T-3: pick the best name-search result using the `(YYYY)` year embedded in
 * the directory name (a first-class part of the naming convention — the
 * year-strip retry below already treats it as such).
 *
 * Selection order, always within TMDB's popularity-sorted result order:
 *   1. exact release/first-air-date year match
 *   2. ±1 year match (regional release dates and December/January premieres
 *      routinely straddle the folder-name year)
 *   3. the popularity-sorted first result (pre-T-3 behavior), also used when
 *      the name carries no year at all
 *
 * This only ever runs for titles with no pinned `tmdb_id` — the
 * `updateTmdbConfigWithId()` add-only ratchet pins the id on first match, so
 * already-matched titles never re-enter this path (their result cannot flip).
 * The heuristic reorders *which* result wins; it never manufactures a match
 * for an empty result set (the no-match contract is unchanged).
 *
 * Exported for unit tests.
 *
 * @param {Array<Object>} results - Non-empty TMDB search results (popularity order)
 * @param {string} name - Directory name, possibly carrying "(YYYY)"
 * @param {string} type - 'movie' or 'tv' (selects release_date vs first_air_date)
 * @returns {Object} The chosen result
 */
export function pickSearchResultByYear(results, name, type) {
  const yearToken = name.match(/\((\d{4})\)/);
  if (!yearToken) return results[0];
  const wantedYear = parseInt(yearToken[1], 10);

  const yearOf = (result) => {
    const date = type === "tv" ? result.first_air_date : result.release_date;
    if (!date) return null;
    const year = parseInt(String(date).slice(0, 4), 10);
    return Number.isNaN(year) ? null : year;
  };

  const exact = results.find((result) => yearOf(result) === wantedYear);
  if (exact) return exact;

  const near = results.find((result) => {
    const year = yearOf(result);
    return year !== null && Math.abs(year - wantedYear) === 1;
  });
  if (near) return near;

  return results[0];
}

/**
 * Fetch comprehensive media details including cast, trailer, logo, and rating
 * Similar to the Python script's fetch_tmdb_media_details function
 * @param {string} name - Media name for search
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} tmdbId - Optional TMDB ID (if known)
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Comprehensive media details
 */
export const fetchComprehensiveMediaDetails = async (
  name,
  type = "tv",
  tmdbId = null,
  includeBlurhash = false,
) => {
  let id = tmdbId;

  // If no TMDB ID provided, search for it. Result selection goes through the
  // T-3 year heuristic (see pickSearchResultByYear above); the year always
  // comes from the ORIGINAL name, including on the year-stripped retry.
  if (!id) {
    const searchResults = await searchMedia(type, name);
    if (!searchResults.results || searchResults.results.length === 0) {
      // Try removing year from name and search again
      const nameWithoutYear = name.replace(/\s*\(\d{4}\)/, "");
      const retryResults = await searchMedia(type, nameWithoutYear);
      if (!retryResults.results || retryResults.results.length === 0) {
        throw new TmdbNoMatchError(`No results found for ${type}: ${name}`);
      }
      id = pickSearchResultByYear(retryResults.results, name, type).id;
    } else {
      id = pickSearchResultByYear(searchResults.results, name, type).id;
    }
  }

  // Fetch all details in parallel
  const [details, castData, videos, images, rating] = await Promise.all([
    getMediaDetails(type, id, includeBlurhash),
    getStructuredMediaCast(type, id, false), // Get structured cast (main + recurring, no guest)
    getMediaVideos(type, id),
    getMediaImages(type, id, includeBlurhash),
    getMediaRating(type, id),
  ]);

  // Combine all data similar to Python script
  return {
    ...details,
    ...castData, // Spread cast, recurring_cast (and guest_cast if present)
    trailer_url: videos.trailer_url,
    logo_path: images.logo_path,
    rating: rating.rating,
    last_updated: new Date().toISOString(),
  };
};

/**
 * Search for movie collections
 * @param {string} query - Search query
 * @param {number} page - Page number (default: 1)
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Collection search results
 */
export const searchCollections = async (
  query,
  page = 1,
  includeBlurhash = false,
) => {
  if (!query) {
    throw new Error("Query parameter is required");
  }

  return await makeTmdbRequest(
    "/search/collection",
    { query, page },
    3,
    1440,
    false,
    includeBlurhash,
  );
};

/**
 * Get detailed information for a movie collection
 * @param {string|number} id - Collection ID
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Collection details with last_updated timestamp and runtime data
 */
export const getCollectionDetails = async (id, includeBlurhash = false) => {
  const data = await makeTmdbRequest(
    `/collection/${id}`,
    {},
    3,
    1440,
    false,
    includeBlurhash,
  );

  // Add last updated timestamp like the Python script
  data.last_updated = new Date().toISOString();

  // Format parts (movies in collection) with full poster URLs and runtime data
  if (data.parts) {
    // Fetch runtime data for each movie, capped per collection (T-4a) — a
    // large collection previously fanned out one request per part at once.
    const partLimit = pLimit(COLLECTION_FANOUT_CONCURRENCY);
    const moviesWithRuntimePromises = data.parts.map((movie) => partLimit(async () => {
      try {
        // Fetch basic movie details to get runtime
        const movieDetails = await makeTmdbRequest(`/movie/${movie.id}`);

        return {
          ...movie,
          runtime: movieDetails.runtime || null,
          vote_average: movieDetails.vote_average,
          vote_count: movieDetails.vote_count,
          genres: movieDetails.genres,
          poster_path: movie.poster_path
            ? `https://image.tmdb.org/t/p/original${movie.poster_path}`
            : null,
          backdrop_path: movie.backdrop_path
            ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}`
            : null,
        };
      } catch (error) {
        logger.warn(
          `Failed to fetch runtime for movie ${movie.id}: ${error.message}`,
        );
        // Return movie with null runtime if request fails
        return {
          ...movie,
          runtime: null,
          poster_path: movie.poster_path
            ? `https://image.tmdb.org/t/p/original${movie.poster_path}`
            : null,
          backdrop_path: movie.backdrop_path
            ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}`
            : null,
        };
      }
    }));

    data.parts = await Promise.all(moviesWithRuntimePromises);
  }

  // Format main collection poster and backdrop
  if (data.poster_path) {
    data.poster_path = `https://image.tmdb.org/t/p/original${data.poster_path}`;
  }
  if (data.backdrop_path) {
    data.backdrop_path = `https://image.tmdb.org/t/p/original${data.backdrop_path}`;
  }

  return data;
};

/**
 * Get images for a movie collection
 * @param {string|number} id - Collection ID
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Collection images with formatted URLs
 */
export const getCollectionImages = async (id, includeBlurhash = false) => {
  const data = await makeTmdbRequest(
    `/collection/${id}/images`,
    {
      include_image_language: "en,null",
    },
    3,
    1440,
    false,
    includeBlurhash,
  );

  // Format all image paths to full URLs
  const formatImages = (images) => {
    return (
      images?.map((image) => ({
        ...image,
        file_path: `https://image.tmdb.org/t/p/original${image.file_path}`,
      })) || []
    );
  };

  return {
    backdrops: formatImages(data.backdrops),
    posters: formatImages(data.posters),
  };
};

/**
 * Get TMDB image URL with specified size
 * @param {string} filePath - TMDB image file path
 * @param {string} size - Image size (e.g., 'original', 'w780', 'w500')
 * @returns {string} Full image URL
 */
export const getTMDBImageURL = (filePath, size = "original") => {
  if (!filePath) return null;
  return `https://image.tmdb.org/t/p/${size}${filePath}`;
};

/**
 * Make a direct TMDB request (alias for makeTmdbRequest for compatibility)
 * @param {string} endpoint - TMDB API endpoint
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>} TMDB API response data
 */
export const makeRequest = async (endpoint, params = {}) => {
  return await makeTmdbRequest(endpoint, params);
};

/**
 * Fetch enhanced collection data with aggregated statistics
 * @param {number} collectionId - TMDB collection ID
 * @param {boolean} includeBlurhash - Include blurhash data for images
 * @returns {Promise<Object>} Enhanced collection object with aggregated data
 */
export async function fetchEnhancedCollectionData(
  collectionId,
  includeBlurhash = false,
) {
  try {
    logger.info(
      `[COLLECTION_ENHANCEMENT] Fetching enhanced data for collection ${collectionId}`,
    );

    // 1. Fetch basic collection data
    const collection = await getCollectionDetails(
      collectionId,
      includeBlurhash,
    );

    if (!collection || !collection.parts) {
      throw new Error("Invalid collection data received");
    }

    logger.info(
      `[COLLECTION_ENHANCEMENT] Found ${collection.parts.length} movies in collection`,
    );

    // 2. Fetch detailed data for each movie, capped per collection (T-4a),
    // with error handling
    const partLimit = pLimit(COLLECTION_FANOUT_CONCURRENCY);
    const enhancedMoviesPromises = collection.parts.map((movie) => partLimit(async () => {
      try {
        // Use the enhanced details endpoint that includes credits and videos
        const movieDetails = await makeRequest(`/movie/${movie.id}`, {
          append_to_response: "credits,videos,images",
        });

        return {
          ...movie,
          // Include runtime as direct property for frontend duration display
          runtime: movieDetails.runtime,
          vote_average: movieDetails.vote_average,
          vote_count: movieDetails.vote_count,
          genres: movieDetails.genres,
          credits: movieDetails.credits || null,
          videos: movieDetails.videos || null,
          images: movieDetails.images || null,
          // Keep the enhanced metadata
          enhancedMetadata: {
            runtime: movieDetails.runtime,
            budget: movieDetails.budget,
            revenue: movieDetails.revenue,
            production_companies: movieDetails.production_companies,
            spoken_languages: movieDetails.spoken_languages,
            vote_average: movieDetails.vote_average,
            vote_count: movieDetails.vote_count,
            genres: movieDetails.genres,
          },
        };
      } catch (error) {
        logger.warn(
          `[COLLECTION_ENHANCEMENT] Failed to fetch enhanced data for movie ${movie.id}: ${error.message}`,
        );
        // Return movie with null enhanced data rather than failing entirely
        return {
          ...movie,
          // Ensure runtime is null rather than undefined for failed requests
          runtime: null,
          credits: null,
          videos: null,
          images: null,
          enhancedMetadata: null,
        };
      }
    }));

    const enhancedMovies = await Promise.all(enhancedMoviesPromises);

    // 3. Aggregate data from enhanced movies
    const aggregatedData = aggregateCollectionData(enhancedMovies);

    logger.info(
      `[COLLECTION_ENHANCEMENT] Successfully aggregated data for collection ${collectionId}`,
    );

    return {
      ...collection,
      enhancedParts: enhancedMovies,
      aggregatedData,
    };
  } catch (error) {
    logger.error(
      `[COLLECTION_ENHANCEMENT] Error fetching enhanced collection data: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Aggregate statistics and contributor data from enhanced movie data
 * @param {Array} enhancedMovies - Movies with credits, videos, and images
 * @returns {Object} Aggregated statistics and contributor data
 */
export function aggregateCollectionData(enhancedMovies) {
  try {
    logger.info(
      `[COLLECTION_ENHANCEMENT] Aggregating data from ${enhancedMovies.length} movies`,
    );

    // Filter out movies that failed to load enhanced data
    const validMovies = enhancedMovies.filter(
      (movie) => movie.credits !== null,
    );

    logger.info(
      `[COLLECTION_ENHANCEMENT] ${validMovies.length} movies have valid enhancement data`,
    );

    const aggregatedData = {
      topCast: aggregateTopCast(validMovies),
      topDirectors: aggregateTopDirectors(validMovies),
      topWriters: aggregateTopWriters(validMovies),
      statistics: calculateCollectionStatistics(enhancedMovies), // Use all movies for stats
      featuredTrailer: findBestTrailer(validMovies),
      featuredArtwork: selectFeaturedArtwork(validMovies),
    };

    logger.info(
      `[COLLECTION_ENHANCEMENT] Aggregation complete - found ${aggregatedData.topCast.length} top cast, ${aggregatedData.topDirectors.length} directors`,
    );

    return aggregatedData;
  } catch (error) {
    logger.error(
      `[COLLECTION_ENHANCEMENT] Error aggregating collection data: ${error.message}`,
    );
    // Return empty aggregated data rather than failing
    return {
      topCast: [],
      topDirectors: [],
      topWriters: [],
      statistics: null,
      featuredTrailer: null,
      featuredArtwork: null,
    };
  }
}

/**
 * Aggregate top cast members across the collection
 * @param {Array} movies - Movies with credits data
 * @returns {Array} Top cast members sorted by appearance frequency and billing
 */
export function aggregateTopCast(movies) {
  const castFrequency = new Map();

  movies.forEach((movie) => {
    if (movie.credits?.cast) {
      // Only consider top 15 billed actors per movie to focus on main cast
      movie.credits.cast.slice(0, 15).forEach((castMember, index) => {
        const key = castMember.id;

        if (!castFrequency.has(key)) {
          castFrequency.set(key, {
            id: castMember.id,
            name: castMember.name,
            profile_path: castMember.profile_path,
            appearances: 0,
            movies: [],
            totalOrder: 0,
            characters: [],
          });
        }

        const existing = castFrequency.get(key);
        existing.appearances++;
        existing.movies.push(movie.title);
        existing.totalOrder += index; // Lower numbers mean higher billing
        if (castMember.character) {
          existing.characters.push(castMember.character);
        }
      });
    }
  });

  return Array.from(castFrequency.values())
    .filter((actor) => actor.appearances >= 1) // At least 1 appearance
    .sort((a, b) => {
      // Primary sort: by number of appearances (descending)
      if (a.appearances !== b.appearances) {
        return b.appearances - a.appearances;
      }
      // Secondary sort: by average billing order (ascending - lower is better)
      return a.totalOrder / a.appearances - b.totalOrder / b.appearances;
    })
    .slice(0, 12); // Return top 12 cast members
}

/**
 * Aggregate top directors across the collection
 * @param {Array} movies - Movies with crew credits data
 * @returns {Array} Directors sorted by number of movies directed
 */
export function aggregateTopDirectors(movies) {
  const directorFrequency = new Map();

  movies.forEach((movie) => {
    if (movie.credits?.crew) {
      const directors = movie.credits.crew.filter(
        (member) => member.job === "Director",
      );

      directors.forEach((director) => {
        const key = director.id;

        if (!directorFrequency.has(key)) {
          directorFrequency.set(key, {
            id: director.id,
            name: director.name,
            profile_path: director.profile_path,
            movieCount: 0,
            movieTitles: [],
          });
        }

        const existing = directorFrequency.get(key);
        existing.movieCount++;
        existing.movieTitles.push(movie.title);
      });
    }
  });

  return Array.from(directorFrequency.values())
    .sort((a, b) => b.movieCount - a.movieCount)
    .slice(0, 6); // Return top 6 directors
}

/**
 * Aggregate top writers across the collection
 * @param {Array} movies - Movies with crew credits data
 * @returns {Array} Writers sorted by number of movies written
 */
export function aggregateTopWriters(movies) {
  const writerFrequency = new Map();

  movies.forEach((movie) => {
    if (movie.credits?.crew) {
      // Include various writing roles
      const writers = movie.credits.crew.filter((member) =>
        ["Screenplay", "Writer", "Story", "Characters"].includes(member.job),
      );

      writers.forEach((writer) => {
        const key = writer.id;

        if (!writerFrequency.has(key)) {
          writerFrequency.set(key, {
            id: writer.id,
            name: writer.name,
            profile_path: writer.profile_path,
            movieCount: 0,
            movieTitles: [],
            jobs: new Set(),
          });
        }

        const existing = writerFrequency.get(key);
        existing.movieCount++;
        existing.movieTitles.push(movie.title);
        existing.jobs.add(writer.job);
      });
    }
  });

  return Array.from(writerFrequency.values())
    .map((writer) => ({
      ...writer,
      jobs: Array.from(writer.jobs), // Convert Set to Array
    }))
    .sort((a, b) => b.movieCount - a.movieCount)
    .slice(0, 4); // Return top 4 writers
}

/**
 * Calculate comprehensive collection statistics
 * @param {Array} movies - All movies in the collection (including those without enhanced data)
 * @returns {Object} Collection-wide statistics
 */
export function calculateCollectionStatistics(movies) {
  const validMovies = movies.filter((m) => m.vote_average && m.release_date);

  if (validMovies.length === 0) {
    return null;
  }

  // Calculate average rating (weighted by vote count)
  const totalVotes = validMovies.reduce(
    (sum, m) => sum + (m.vote_count || 0),
    0,
  );
  const weightedRatingSum = validMovies.reduce((sum, m) => {
    const weight = (m.vote_count || 0) / totalVotes || 1 / validMovies.length;
    return sum + m.vote_average * weight;
  }, 0);

  // Calculate total runtime from enhanced metadata
  const moviesWithRuntime = movies.filter((m) => m.enhancedMetadata?.runtime);
  const totalRuntime = moviesWithRuntime.reduce(
    (sum, m) => sum + m.enhancedMetadata.runtime,
    0,
  );

  // Genre breakdown
  const genreBreakdown = calculateGenreBreakdown(validMovies);

  // Release span
  const releaseDates = validMovies
    .map((m) => m.release_date)
    .filter(Boolean)
    .sort();

  const releaseSpan =
    releaseDates.length > 0
      ? {
          earliest: releaseDates[0],
          latest: releaseDates[releaseDates.length - 1],
          spanYears:
            new Date(releaseDates[releaseDates.length - 1]).getFullYear() -
            new Date(releaseDates[0]).getFullYear(),
        }
      : null;

  // Production companies (from enhanced metadata)
  const productionCompanies = aggregateProductionCompanies(movies);

  return {
    averageRating: weightedRatingSum,
    totalRuntime,
    averageRuntime:
      moviesWithRuntime.length > 0
        ? Math.round(totalRuntime / moviesWithRuntime.length)
        : null,
    genreBreakdown,
    releaseSpan,
    productionCompanies,
    movieCount: movies.length,
    validDataCount: validMovies.length,
  };
}

/**
 * Calculate genre distribution across movies
 * @param {Array} movies - Movies with genre data
 * @returns {Array} Genre breakdown with counts and percentages
 */
function calculateGenreBreakdown(movies) {
  const genreCounts = new Map();
  const totalMovies = movies.length;

  movies.forEach((movie) => {
    if (movie.genres) {
      movie.genres.forEach((genre) => {
        const current = genreCounts.get(genre.id) || { ...genre, count: 0 };
        current.count++;
        genreCounts.set(genre.id, current);
      });
    }
  });

  return Array.from(genreCounts.values())
    .map((genre) => ({
      ...genre,
      percentage: Math.round((genre.count / totalMovies) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8); // Top 8 genres
}

/**
 * Aggregate production companies across the collection
 * @param {Array} movies - Movies with enhanced metadata
 * @returns {Array} Production companies with counts
 */
function aggregateProductionCompanies(movies) {
  const companyCounts = new Map();

  movies.forEach((movie) => {
    if (movie.enhancedMetadata?.production_companies) {
      movie.enhancedMetadata.production_companies.forEach((company) => {
        const current = companyCounts.get(company.id) || {
          ...company,
          count: 0,
        };
        current.count++;
        companyCounts.set(company.id, current);
      });
    }
  });

  return Array.from(companyCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5); // Top 5 production companies
}

/**
 * Find the best trailer to feature for the collection
 * @param {Array} movies - Movies with video data
 * @returns {Object|null} Best trailer information
 */
export function findBestTrailer(movies) {
  let bestTrailer = null;
  let bestScore = 0;

  movies.forEach((movie) => {
    if (movie.videos?.results) {
      const trailers = movie.videos.results.filter(
        (video) => video.type === "Trailer" && video.site === "YouTube",
      );

      trailers.forEach((trailer) => {
        // Score trailers based on quality and type
        let score = 0;

        // Prefer official trailers
        if (trailer.name.toLowerCase().includes("official")) score += 3;
        if (trailer.name.toLowerCase().includes("main")) score += 2;

        // Prefer higher quality
        if (trailer.size >= 1080) score += 2;
        else if (trailer.size >= 720) score += 1;

        // Prefer more recent movies (proxy for better trailer quality)
        const releaseYear = movie.release_date
          ? new Date(movie.release_date).getFullYear()
          : 0;
        if (releaseYear >= 2010) score += 1;
        if (releaseYear >= 2020) score += 1;

        if (score > bestScore) {
          bestScore = score;
          bestTrailer = {
            movieId: movie.id,
            movieTitle: movie.title,
            trailerKey: trailer.key,
            trailerName: trailer.name,
            trailerSite: trailer.site,
            trailerSize: trailer.size,
          };
        }
      });
    }
  });

  return bestTrailer;
}

/**
 * Select featured artwork from across the collection
 * @param {Array} movies - Movies with image data
 * @returns {Object} Featured artwork selections
 */
export function selectFeaturedArtwork(movies) {
  const backdrops = [];
  const posters = [];
  const logos = [];

  movies.forEach((movie) => {
    if (movie.images) {
      // Select high-quality backdrops
      if (movie.images.backdrops) {
        movie.images.backdrops
          .filter(
            (backdrop) =>
              backdrop.vote_average >= 5.5 && backdrop.width >= 1920,
          )
          .slice(0, 2) // Top 2 per movie
          .forEach((backdrop) => {
            backdrops.push({
              ...backdrop,
              movieTitle: movie.title,
              fullPath: getTMDBImageURL(backdrop.file_path, "original"),
            });
          });
      }

      // Select variety of posters
      if (movie.images.posters) {
        movie.images.posters
          .filter((poster) => poster.vote_average >= 5.0)
          .slice(0, 1) // Best poster per movie
          .forEach((poster) => {
            posters.push({
              ...poster,
              movieTitle: movie.title,
              fullPath: getTMDBImageURL(poster.file_path, "w780"),
            });
          });
      }

      // Collect logos if available
      if (movie.images.logos) {
        movie.images.logos
          .filter((logo) => logo.file_path && logo.vote_average >= 5.0)
          .slice(0, 1)
          .forEach((logo) => {
            logos.push({
              ...logo,
              movieTitle: movie.title,
              fullPath: getTMDBImageURL(logo.file_path, "w500"),
            });
          });
      }
    }
  });

  return {
    backdrops: backdrops
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 8), // Top 8 backdrops
    posters: posters
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 12), // Top 12 posters for variety
    logos: logos.sort((a, b) => b.vote_average - a.vote_average).slice(0, 6), // Top 6 logos
  };
}

/**
 * Format runtime in hours and minutes
 * @param {number} totalMinutes - Total runtime in minutes
 * @returns {string} Formatted runtime string
 */
export function formatRuntime(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return "Unknown";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  } else if (minutes === 0) {
    return `${hours}h`;
  } else {
    return `${hours}h ${minutes}m`;
  }
}

/**
 * Get contributor filter function for filtering movies by cast/crew
 * @param {Object} contributor - The contributor to filter by
 * @param {string} contributor.type - 'actor' or 'director'
 * @param {number} contributor.id - TMDB person ID
 * @returns {Function} Filter function for movies
 */
export function getContributorFilter(contributor) {
  if (!contributor) return null;

  return (movie) => {
    if (!movie.credits) return false;

    if (contributor.type === "actor") {
      return movie.credits.cast?.some((actor) => actor.id === contributor.id);
    } else if (contributor.type === "director") {
      return movie.credits.crew?.some(
        (crew) => crew.id === contributor.id && crew.job === "Director",
      );
    }

    return false;
  };
}
