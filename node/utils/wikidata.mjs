import axios from "axios";
import pLimit from "p-limit";
import { getTmdbCache, setTmdbCache } from "../sqliteDatabase.mjs";

const WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";
const CACHE_ENDPOINT = "wikidata:/movie-rating/v1";
const POSITIVE_CACHE_TTL_HOURS = 1440;
const NEGATIVE_CACHE_TTL_HOURS = 168;
const RESPONSE_LIMIT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT =
  "nextjs-stream-media-processor/1.0.1 (https://github.com/Apezdr/nextjs-stream-media-processor)";

const requestLimit = pLimit(1);
const inFlight = new Map();

let blockedUntil = 0;
let consecutiveFailures = 0;

const RATING_CODES_BY_ENTITY = Object.freeze({
  Q18665330: "G",
  Q18665334: "PG",
  Q18665339: "PG-13",
  Q18665344: "R",
  Q18665349: "NC-17",
});

const TERMINAL_NEGATIVE_STATUSES = new Set([
  "ambiguous",
  "identity-conflict",
  "miss",
  "no-rating",
  "unsupported-rating",
]);

function normalizeTmdbMovieId(value) {
  const candidate = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value
      : "";
  return /^[1-9]\d{0,7}$/.test(candidate) ? candidate : null;
}

function normalizeImdbId(value) {
  if (value == null || value === "") return null;
  return typeof value === "string" && /^tt\d{7,8}$/.test(value) ? value : undefined;
}

function normalizeEntityId(value) {
  return typeof value === "string" && /^Q[1-9]\d{0,15}$/.test(value) ? value : null;
}

function stringValue(snak) {
  const value = snak?.snaktype === "value" && snak?.datavalue?.type === "string"
    ? snak.datavalue.value
    : null;
  return typeof value === "string" ? value : null;
}

function entityValue(snak) {
  const value = snak?.snaktype === "value"
    && snak?.datavalue?.type === "wikibase-entityid"
    ? snak.datavalue.value?.id
    : null;
  return normalizeEntityId(value);
}

function qualifierValues(statement, property, extractor) {
  const snaks = statement?.qualifiers?.[property];
  if (!Array.isArray(snaks)) return [];
  return [...new Set(snaks.map(extractor).filter(Boolean))];
}

function claimValues(claims, property, extractor) {
  const statements = claims?.[property];
  if (!Array.isArray(statements)) return [];
  return [...new Set(statements.map((statement) => extractor(statement?.mainsnak)).filter(Boolean))];
}

function sanitizeDescriptor(value) {
  if (typeof value !== "string") return null;
  const descriptor = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!descriptor || descriptor.length > 160) return null;
  if (/[<>\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(descriptor)
    || /&(?:lt|gt|#0*(?:60|62)|#x0*3[ce]);/i.test(descriptor)) {
    return null;
  }
  return descriptor;
}

function sanitizeDescriptors(value) {
  if (!Array.isArray(value)) return [];
  const descriptors = [];
  const seen = new Set();
  for (const candidate of value.slice(0, 32)) {
    const descriptor = sanitizeDescriptor(candidate);
    const key = descriptor?.toLocaleLowerCase("en-US");
    if (!descriptor || seen.has(key)) continue;
    seen.add(key);
    descriptors.push(descriptor);
    if (descriptors.length === 8) break;
  }
  return descriptors;
}

function sanitizeCertificateId(value) {
  if (typeof value !== "string") return null;
  const certificateId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,31}$/.test(certificateId)
    ? certificateId
    : null;
}

function normalizeStatementId(value) {
  return typeof value === "string" && /^Q[1-9]\d{0,15}\$[A-Za-z0-9-]{1,80}$/.test(value)
    ? value
    : null;
}

function normalizeReferenceUrl(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (hostname !== "filmratings.com"
      && !hostname.endsWith(".filmratings.com")
      && hostname !== "motionpictures.org"
      && !hostname.endsWith(".motionpictures.org")) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizePublicationDate(value) {
  const time = value?.snaktype === "value" && value?.datavalue?.type === "time"
    ? value.datavalue.value?.time
    : null;
  const match = typeof time === "string"
    ? time.match(/^\+(\d{4}-\d{2}-\d{2})T/)
    : null;
  return match?.[1] || null;
}

function normalizeDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
    ? value
    : null;
}

function normalizeRetrievedAt(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function extractReference(statement) {
  if (!Array.isArray(statement?.references)) return {};

  for (const reference of statement.references.slice(0, 16)) {
    const snaks = reference?.snaks;
    const referenceUrl = (snaks?.P854 || [])
      .map(stringValue)
      .map(normalizeReferenceUrl)
      .find(Boolean);
    if (!referenceUrl) continue;

    const referencePublisherId = (snaks?.P123 || [])
      .map(entityValue)
      .find(Boolean);
    const referencePublicationDate = (snaks?.P577 || [])
      .map(normalizePublicationDate)
      .find(Boolean);

    return {
      referenceUrl,
      ...(referencePublisherId ? { referencePublisherId } : {}),
      ...(referencePublicationDate ? { referencePublicationDate } : {}),
    };
  }

  return {};
}

function selectCertificate(statement) {
  const current = qualifierValues(statement, "P14671", stringValue)
    .map(sanitizeCertificateId)
    .filter(Boolean);
  const legacy = qualifierValues(statement, "P2676", stringValue)
    .map(sanitizeCertificateId)
    .filter(Boolean);

  if (current.length > 1 || legacy.length > 1) return {};
  if (current.length === 1 && legacy.length === 1 && current[0] !== legacy[0]) return {};
  if (current.length === 1) {
    return { certificateId: current[0], certificateProperty: "P14671" };
  }
  if (legacy.length === 1) {
    return { certificateId: legacy[0], certificateProperty: "P2676" };
  }
  return {};
}

function responseSize(data) {
  try {
    return Buffer.byteLength(JSON.stringify(data), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 1000), 60 * 60 * 1000);
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 1000), 60 * 60 * 1000);
  }

  return 60 * 1000;
}

function registerFailure(error) {
  consecutiveFailures += 1;
  const retryAfter = error?.response?.headers?.["retry-after"];
  const isRateLimited = error?.response?.status === 429 || error?.code === "wikidata-maxlag";
  if (isRateLimited) {
    blockedUntil = Date.now() + parseRetryAfter(retryAfter);
  } else if (consecutiveFailures >= 3) {
    blockedUntil = Date.now() + 60 * 1000;
  }
}

async function requestJson(params) {
  if (Date.now() < blockedUntil) {
    throw Object.assign(new Error("Wikidata requests are temporarily paused"), {
      code: "wikidata-circuit-open",
    });
  }

  const response = await axios.get(WIKIDATA_API_URL, {
    params,
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: RESPONSE_LIMIT_BYTES,
    maxBodyLength: RESPONSE_LIMIT_BYTES,
    decompress: true,
    proxy: false,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": process.env.WIKIDATA_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    },
  });

  const contentType = String(response?.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json") || responseSize(response.data) > RESPONSE_LIMIT_BYTES) {
    throw Object.assign(new Error("Invalid Wikidata response"), {
      code: "wikidata-invalid-response",
    });
  }
  if (response.data?.error?.code === "maxlag") {
    throw Object.assign(new Error("Wikidata is lagged"), {
      code: "wikidata-maxlag",
      response: { headers: response.headers },
    });
  }

  consecutiveFailures = 0;
  return response.data;
}

async function searchEntity(tmdbMovieId) {
  const data = await requestJson({
    action: "query",
    list: "search",
    srsearch: `haswbstatement:P4947=${tmdbMovieId}`,
    srnamespace: 0,
    srlimit: 2,
    format: "json",
    formatversion: 2,
    maxlag: 5,
  });
  if (!Array.isArray(data?.query?.search) || data.query.search.length > 2) {
    throw new Error("Malformed Wikidata search response");
  }
  const hits = data.query.search.map((hit) => normalizeEntityId(hit?.title));
  if (hits.some((entityId) => !entityId)) {
    throw new Error("Malformed Wikidata search result");
  }
  return [...new Set(hits)];
}

async function getEntityClaims(entityId) {
  const data = await requestJson({
    action: "wbgetentities",
    ids: entityId,
    props: "claims",
    format: "json",
    formatversion: 2,
    maxlag: 5,
  });
  return data?.entities?.[entityId]?.claims || null;
}

async function resolveDescriptorLabels(entityIds) {
  if (entityIds.length === 0) return [];
  const data = await requestJson({
    action: "wbgetentities",
    ids: entityIds.slice(0, 8).join("|"),
    props: "labels",
    languages: "en",
    format: "json",
    formatversion: 2,
    maxlag: 5,
  });
  if (!data?.entities || typeof data.entities !== "object" || Array.isArray(data.entities)) {
    throw new Error("Malformed Wikidata label response");
  }
  return sanitizeDescriptors(
    entityIds.map((entityId) => data.entities[entityId]?.labels?.en?.value),
  );
}

function selectRatingStatement(claims) {
  const active = Array.isArray(claims?.P1657)
    ? claims.P1657.filter((statement) => statement?.rank !== "deprecated")
    : [];
  const preferred = active.filter((statement) => statement?.rank === "preferred");
  const candidates = preferred.length > 0
    ? preferred
    : active.filter((statement) => statement?.rank === "normal");
  const withRatings = candidates
    .map((statement) => ({ statement, ratingEntityId: entityValue(statement?.mainsnak) }))
    .filter(({ ratingEntityId }) => ratingEntityId);
  const distinctRatings = [...new Set(withRatings.map(({ ratingEntityId }) => ratingEntityId))];

  if (distinctRatings.length === 0) return { status: "no-rating" };
  if (distinctRatings.length > 1) return { status: "ambiguous" };

  const supported = RATING_CODES_BY_ENTITY[distinctRatings[0]];
  if (!supported) return { status: "unsupported-rating" };

  const selected = withRatings
    .filter(({ ratingEntityId }) => ratingEntityId === distinctRatings[0])
    .sort((left, right) => String(left.statement?.id || "").localeCompare(String(right.statement?.id || "")))[0];
  return {
    status: "hit",
    statement: selected.statement,
    ratingEntityId: distinctRatings[0],
    contentRating: supported,
  };
}

function normalizeCachedData(value, tmdbMovieId, imdbId) {
  if (!value || value.schema !== 1 || value.tmdbMovieId !== tmdbMovieId) return null;
  const entityId = normalizeEntityId(value.entityId);
  const ratingEntityId = normalizeEntityId(value.ratingEntityId);
  if (!entityId || !ratingEntityId || RATING_CODES_BY_ENTITY[ratingEntityId] !== value.contentRating) {
    return null;
  }

  const storedImdbId = normalizeImdbId(value.imdbId);
  if (value.imdbId != null && storedImdbId === undefined) return null;
  if (imdbId && storedImdbId && storedImdbId !== imdbId) return null;

  const certificateProperty = ["P14671", "P2676"].includes(value.certificateProperty)
    ? value.certificateProperty
    : null;
  const certificateId = certificateProperty
    ? sanitizeCertificateId(value.certificateId)
    : null;
  const statementId = normalizeStatementId(value.statementId);
  const referenceUrl = normalizeReferenceUrl(value.referenceUrl);
  const referencePublisherId = normalizeEntityId(value.referencePublisherId);
  const referencePublicationDate = normalizeDateOnly(value.referencePublicationDate);
  const retrievedAt = normalizeRetrievedAt(value.retrievedAt);

  return {
    schema: 1,
    entityId,
    tmdbMovieId,
    ...(storedImdbId ? { imdbId: storedImdbId } : {}),
    contentRating: value.contentRating,
    ratingEntityId,
    descriptors: sanitizeDescriptors(value.descriptors),
    ...(certificateId ? { certificateId, certificateProperty } : {}),
    ...(statementId ? { statementId } : {}),
    ...(referenceUrl ? { referenceUrl } : {}),
    ...(referencePublisherId ? { referencePublisherId } : {}),
    ...(referencePublicationDate ? { referencePublicationDate } : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
  };
}

function readCachedEnvelope(cached, tmdbMovieId, imdbId) {
  const envelope = cached?.data;
  if (!envelope || envelope.schema !== 1) return { found: false, data: null };
  if (TERMINAL_NEGATIVE_STATUSES.has(envelope.status)) return { found: true, data: null };
  if (envelope.status !== "hit") return { found: false, data: null };
  const data = normalizeCachedData(envelope.data, tmdbMovieId, imdbId);
  return data ? { found: true, data } : { found: false, data: null };
}

async function writeTerminalCache(tmdbMovieId, envelope, ttlHours) {
  try {
    await setTmdbCache(
      CACHE_ENDPOINT,
      { tmdb_id: tmdbMovieId },
      envelope,
      ttlHours,
    );
  } catch {
    // Optional enrichment remains usable when its disposable cache is unavailable.
  }
}

async function fetchAndCache(tmdbMovieId, imdbId) {
  try {
    const entityIds = await searchEntity(tmdbMovieId);
    if (entityIds.length === 0) {
      await writeTerminalCache(tmdbMovieId, { schema: 1, status: "miss" }, NEGATIVE_CACHE_TTL_HOURS);
      return null;
    }
    if (entityIds.length !== 1) {
      await writeTerminalCache(tmdbMovieId, { schema: 1, status: "ambiguous" }, NEGATIVE_CACHE_TTL_HOURS);
      return null;
    }

    const entityId = entityIds[0];
    const claims = await getEntityClaims(entityId);
    if (!claims) throw new Error("Wikidata entity claims are missing");

    const providerImdbIds = claimValues(claims, "P345", stringValue)
      .filter((value) => /^tt\d{7,8}$/.test(value));
    if (imdbId && providerImdbIds.length > 0 && !providerImdbIds.includes(imdbId)) {
      await writeTerminalCache(
        tmdbMovieId,
        { schema: 1, status: "identity-conflict" },
        NEGATIVE_CACHE_TTL_HOURS,
      );
      return null;
    }

    const selected = selectRatingStatement(claims);
    if (selected.status !== "hit") {
      await writeTerminalCache(
        tmdbMovieId,
        { schema: 1, status: selected.status },
        NEGATIVE_CACHE_TTL_HOURS,
      );
      return null;
    }

    const descriptorEntityIds = qualifierValues(selected.statement, "P7367", entityValue).slice(0, 8);
    const descriptors = await resolveDescriptorLabels(descriptorEntityIds);
    const certificate = selectCertificate(selected.statement);
    const statementId = normalizeStatementId(selected.statement?.id);
    const result = {
      schema: 1,
      entityId,
      tmdbMovieId,
      ...(imdbId ? { imdbId } : providerImdbIds.length === 1 ? { imdbId: providerImdbIds[0] } : {}),
      contentRating: selected.contentRating,
      ratingEntityId: selected.ratingEntityId,
      descriptors,
      ...certificate,
      ...(statementId ? { statementId } : {}),
      ...extractReference(selected.statement),
      retrievedAt: new Date().toISOString(),
    };

    await writeTerminalCache(
      tmdbMovieId,
      { schema: 1, status: "hit", data: result },
      POSITIVE_CACHE_TTL_HOURS,
    );
    return result;
  } catch (error) {
    registerFailure(error);
    return null;
  }
}

export async function getWikidataRatingEnrichment({
  mediaType = "movie",
  tmdbId,
  imdbId = null,
  allowNetwork = false,
} = {}) {
  if (mediaType !== "movie") return null;
  const tmdbMovieId = normalizeTmdbMovieId(tmdbId);
  const normalizedImdbId = normalizeImdbId(imdbId);
  if (!tmdbMovieId || normalizedImdbId === undefined) return null;

  let cached = null;
  try {
    cached = await getTmdbCache(CACHE_ENDPOINT, { tmdb_id: tmdbMovieId });
  } catch {
    cached = null;
  }
  const cacheResult = readCachedEnvelope(cached, tmdbMovieId, normalizedImdbId);
  if (cacheResult.found) return cacheResult.data;
  if (!allowNetwork || Date.now() < blockedUntil) return null;

  const cacheKey = `${CACHE_ENDPOINT}:${tmdbMovieId}`;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const request = requestLimit(() => fetchAndCache(tmdbMovieId, normalizedImdbId))
    .finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request);
  return request;
}

export function resetWikidataRuntimeStateForTests() {
  blockedUntil = 0;
  consecutiveFailures = 0;
  inFlight.clear();
}
