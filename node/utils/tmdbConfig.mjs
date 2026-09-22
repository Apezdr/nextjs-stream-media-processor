import { promises as fs } from 'fs';
import path from 'path';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('tmdb-config');

/**
 * `tmdb_id_source` values with fixed meaning. Any other value is the name of an
 * identity provider (`radarr`, `sonarr`, …) registered in
 * `integrations/identity/registry.mjs`.
 *
 * - `manual` — a human pinned this id. Nothing automated may change it.
 * - `auto`   — the pipeline's own name search chose it. Any provider may
 *              replace it; another search never does.
 */
export const IDENTITY_SOURCE_MANUAL = 'manual';
export const IDENTITY_SOURCE_AUTO = 'auto';

/**
 * How a pin with an id but no `tmdb_id_source` is read. Every pin written
 * before provenance existed looks like this, and most of them were written by
 * the name search — but some were typed by hand, and the file cannot tell us
 * which. `manual` (the default) is the safe reading: a legacy pin is never
 * overwritten, only reported when a provider disagrees. `auto` lets a
 * provider repair legacy pins too; an operator opts into that deliberately
 * (IDENTITY_UNSOURCED_PINS=auto) for one pass and flips it back.
 */
export const UNSOURCED_PIN_TREATMENTS = Object.freeze([IDENTITY_SOURCE_MANUAL, IDENTITY_SOURCE_AUTO]);

const SOURCE_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Load TMDB configuration from tmdb.config file
 * Provides fallback for missing files and handles JSON parsing errors gracefully
 * @param {string} configPath - Path to tmdb.config file
 * @returns {Promise<Object>} Configuration object
 */
export async function loadTmdbConfig(configPath) {
  try {
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    
    if (!exists) {
      logger.debug(`Config file does not exist: ${configPath}, returning defaults`);
      return createDefaultConfig();
    }

    const content = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(content);
    
    // Validate and apply defaults for missing fields
    const validatedConfig = validateTmdbConfig(config);
    
    logger.debug(`Loaded TMDB config from: ${configPath}`);
    return validatedConfig;
    
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.error(`Invalid JSON in config file ${configPath}: ${error.message}`);
      throw new Error(`Invalid JSON in TMDB config: ${error.message}`);
    }
    logger.error(`Failed to load TMDB config from ${configPath}: ${error.message}`);
    throw error;
  }
}

/**
 * Save TMDB configuration to tmdb.config file
 *
 * The file's mtime is load-bearing: the scanner reads "tmdb.config newer than
 * metadata.json" as an operator edit and answers with a force-refresh repull
 * (images wiped and re-downloaded). `preserveMtime` is for writes that change
 * nothing about WHICH entity the folder is — today only a provenance stamp on
 * an unchanged id — so bookkeeping never masquerades as an edit.
 *
 * @param {string} configPath - Path to tmdb.config file
 * @param {Object} config - Configuration object to save
 * @param {Object} [options]
 * @param {boolean} [options.preserveMtime=false] - Restore the previous mtime after writing
 * @returns {Promise<void>}
 */
export async function saveTmdbConfig(configPath, config, { preserveMtime = false } = {}) {
  try {
    // Ensure directory exists
    const configDir = path.dirname(configPath);
    await fs.mkdir(configDir, { recursive: true });

    let previousTimes = null;
    if (preserveMtime) {
      try {
        const stat = await fs.stat(configPath);
        previousTimes = { atime: stat.atime, mtime: stat.mtime };
      } catch {
        // No previous file — nothing to preserve; the write creates it.
      }
    }

    // Validate config before saving
    const validatedConfig = validateTmdbConfig(config);

    // Write with proper formatting
    const configJson = JSON.stringify(validatedConfig, null, 2);
    await fs.writeFile(configPath, configJson, 'utf8');

    if (previousTimes) {
      await fs.utimes(configPath, previousTimes.atime, previousTimes.mtime);
    }

    logger.debug(`Saved TMDB config to: ${configPath}`);

  } catch (error) {
    logger.error(`Failed to save TMDB config to ${configPath}: ${error.message}`);
    throw error;
  }
}

/**
 * Who pinned the id a config carries, in the vocabulary the precedence rules
 * use. This is the ONLY place the "id without a source" reading lives.
 *
 * @param {Object} config - Loaded configuration
 * @param {Object} [options]
 * @param {'manual'|'auto'} [options.unsourcedPinTreatment='manual'] - See UNSOURCED_PIN_TREATMENTS
 * @returns {{tmdbId: number|null, source: string|null}} `source` is null iff there is no id
 */
export function getIdentityProvenance(config, { unsourcedPinTreatment = IDENTITY_SOURCE_MANUAL } = {}) {
  const tmdbId = Number.isInteger(config?.tmdb_id) && config.tmdb_id > 0 ? config.tmdb_id : null;
  if (!tmdbId) return { tmdbId: null, source: null };
  const stored = typeof config.tmdb_id_source === 'string' ? config.tmdb_id_source.trim() : '';
  if (stored) return { tmdbId, source: stored };
  const treatment = UNSOURCED_PIN_TREATMENTS.includes(unsourcedPinTreatment)
    ? unsourcedPinTreatment
    : IDENTITY_SOURCE_MANUAL;
  return { tmdbId, source: treatment };
}

/**
 * The precedence rule for `tmdb_id`: who may change it, and when. Pure.
 *
 * A human pin (`manual`) is the only thing that beats a provider, and a
 * provider is the only thing that beats an automatic match. A second name
 * search never changes an existing pin of any kind — that is the ratchet the
 * rest of the pipeline relies on.
 *
 * | stored source        | incoming        | decision                              |
 * |----------------------|-----------------|---------------------------------------|
 * | none                 | anything        | write id + source                     |
 * | manual               | same id         | keep                                  |
 * | manual               | different id    | conflict (report, never write)        |
 * | auto or provider     | auto            | keep (search never overwrites)        |
 * | auto or provider     | provider, same  | stamp source only (no mtime change)   |
 * | auto or provider     | provider, diff  | write id + source (the repair)        |
 *
 * @param {Object} config - Loaded configuration
 * @param {{tmdbId: number, source: string}} incoming - The id being offered and who offers it
 * @param {Object} [options]
 * @param {'manual'|'auto'} [options.unsourcedPinTreatment]
 * @returns {{action: 'write'|'stamp'|'keep'|'conflict', reason: string, tmdbId?: number, source?: string, storedId?: number|null, storedSource?: string|null}}
 */
export function resolveIdentityPin(config, incoming, options = {}) {
  const incomingId = Number(incoming?.tmdbId);
  const incomingSource = typeof incoming?.source === 'string' && incoming.source.trim()
    ? incoming.source.trim()
    : IDENTITY_SOURCE_AUTO;
  if (!Number.isInteger(incomingId) || incomingId <= 0) {
    return { action: 'keep', reason: 'incoming-id-invalid' };
  }

  const stored = getIdentityProvenance(config, options);
  const base = { storedId: stored.tmdbId, storedSource: stored.source };

  if (!stored.tmdbId) {
    return { ...base, action: 'write', reason: 'no-stored-id', tmdbId: incomingId, source: incomingSource };
  }

  if (stored.source === IDENTITY_SOURCE_MANUAL) {
    if (stored.tmdbId === incomingId) {
      return { ...base, action: 'keep', reason: 'manual-pin-agrees' };
    }
    return { ...base, action: 'conflict', reason: 'manual-pin-disagrees', tmdbId: incomingId, source: incomingSource };
  }

  // Stored pin is automatic or provider-owned: overwritable, but only by a provider.
  if (incomingSource === IDENTITY_SOURCE_AUTO) {
    return { ...base, action: 'keep', reason: 'search-never-overwrites' };
  }
  if (stored.tmdbId === incomingId) {
    if (stored.source === incomingSource) {
      return { ...base, action: 'keep', reason: 'provider-agrees' };
    }
    return { ...base, action: 'stamp', reason: 'provider-agrees-stamp-source', tmdbId: incomingId, source: incomingSource };
  }
  return { ...base, action: 'write', reason: 'provider-replaces-automatic-pin', tmdbId: incomingId, source: incomingSource };
}

/**
 * Offer an id for a title and apply the precedence rule to its tmdb.config.
 *
 * `write` saves id + source normally, so the mtime moves and the scanner's
 * stale-by-config gate turns the change into a force-refresh repull.
 * `stamp` records provenance only and preserves the mtime — nothing about the
 * entity changed, so nothing downstream should re-run.
 * `keep` and `conflict` touch nothing.
 *
 * @param {string} configPath - Path to tmdb.config file
 * @param {{tmdbId: number, source: string}} incoming
 * @param {Object} [options]
 * @param {string} [options.mediaName] - For logging
 * @param {'manual'|'auto'} [options.unsourcedPinTreatment]
 * @returns {Promise<{decision: Object, config: Object}>}
 */
export async function pinTmdbIdentity(configPath, incoming, options = {}) {
  const { mediaName = path.basename(path.dirname(configPath)) } = options;
  const config = await loadTmdbConfig(configPath);
  const decision = resolveIdentityPin(config, incoming, options);

  switch (decision.action) {
    case 'write':
      config.tmdb_id = decision.tmdbId;
      config.tmdb_id_source = decision.source;
      await saveTmdbConfig(configPath, config);
      if (decision.storedId) {
        logger.info(
          `Replaced tmdb_id ${decision.storedId} (${decision.storedSource}) with ${decision.tmdbId} (${decision.source}) for '${mediaName}'`
        );
      } else {
        logger.info(`Added tmdb_id ${decision.tmdbId} (${decision.source}) to config for '${mediaName}'`);
      }
      break;
    case 'stamp':
      config.tmdb_id_source = decision.source;
      await saveTmdbConfig(configPath, config, { preserveMtime: true });
      logger.info(`Stamped tmdb_id ${decision.tmdbId} as ${decision.source} for '${mediaName}' (was ${decision.storedSource})`);
      break;
    case 'conflict':
      logger.warn(
        `Identity conflict for '${mediaName}': manual pin ${decision.storedId} vs ${decision.source} ${decision.tmdbId}; keeping the manual pin`
      );
      break;
    default:
      logger.debug(`TMDB ID unchanged for '${mediaName}' (${decision.reason})`);
  }

  return { decision, config };
}

/**
 * The name-search ratchet: pin an id the pipeline found itself.
 *
 * Kept as the generator's entry point. It only ever ADDS an id (a search never
 * overwrites any existing pin, see `resolveIdentityPin`) and stamps the pin
 * `auto` so a provider may later correct it — the whole reason provenance
 * exists. Pass a provider name as `source` only from the identity reconciler.
 *
 * @param {string} configPath - Path to tmdb.config file
 * @param {number} tmdbId - TMDB ID to set
 * @param {string} mediaName - Name of media for logging
 * @param {Object} [options]
 * @param {string} [options.source='auto'] - Who found the id
 * @returns {Promise<Object>} Updated configuration
 */
export async function updateTmdbConfigWithId(configPath, tmdbId, mediaName, { source = IDENTITY_SOURCE_AUTO } = {}) {
  try {
    const { config } = await pinTmdbIdentity(configPath, { tmdbId, source }, { mediaName });
    return config;
  } catch (error) {
    logger.error(`Failed to update TMDB config for '${mediaName}': ${error.message}`);
    throw error;
  }
}

/**
 * Provenance for a whole-file write made by an operator (the admin PUT).
 *
 * The PUT is a full replace (A-2), so the client echoes back whatever it read
 * — including a provider's `tmdb_id_source`. Without this step a human who
 * changes the id in that form would leave the pin marked as the provider's,
 * and the next reconcile would put the provider's id straight back. So: an id
 * that was added or changed by this write is `manual`, whatever the client
 * sent; an unchanged id keeps the source it had if the client dropped it.
 * Returns a new object; the input is not mutated.
 *
 * @param {Object} previousConfig - What was on disk (defaults if absent)
 * @param {Object} nextConfig - What the operator submitted
 * @returns {Object} nextConfig with provenance settled
 */
export function stampProvenanceForOperatorWrite(previousConfig, nextConfig) {
  const next = { ...(nextConfig || {}) };
  const prev = getIdentityProvenance(previousConfig || {});
  const nextId = Number.isInteger(next.tmdb_id) && next.tmdb_id > 0 ? next.tmdb_id : null;

  if (!nextId) {
    delete next.tmdb_id_source;
    return next;
  }
  if (prev.tmdbId === nextId) {
    if (!next.tmdb_id_source && previousConfig?.tmdb_id_source) {
      next.tmdb_id_source = previousConfig.tmdb_id_source;
    }
    return next;
  }
  next.tmdb_id_source = IDENTITY_SOURCE_MANUAL;
  return next;
}

/**
 * Validate TMDB configuration object and apply defaults
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validated configuration with defaults applied
 */
export function validateTmdbConfig(config) {
  if (!config || typeof config !== 'object') {
    return createDefaultConfig();
  }
  
  const validated = {
    ...createDefaultConfig(),
    ...config
  };
  
  // Validate specific fields
  if (validated.tmdb_id && (!Number.isInteger(validated.tmdb_id) || validated.tmdb_id <= 0)) {
    logger.warn(`Invalid tmdb_id: ${validated.tmdb_id}, removing from config`);
    delete validated.tmdb_id;
  }

  // Provenance is meaningless without an id, and must be a plain token
  // (`manual`, `auto`, or a provider name). Anything else is dropped, which
  // reads as an unsourced pin — the conservative default.
  if (validated.tmdb_id_source !== undefined) {
    const source = typeof validated.tmdb_id_source === 'string' ? validated.tmdb_id_source.trim() : '';
    if (!validated.tmdb_id) {
      logger.debug('tmdb_id_source present without tmdb_id, removing from config');
      delete validated.tmdb_id_source;
    } else if (!SOURCE_TOKEN.test(source)) {
      logger.warn(`Invalid tmdb_id_source: ${JSON.stringify(validated.tmdb_id_source)}, removing from config`);
      delete validated.tmdb_id_source;
    } else {
      validated.tmdb_id_source = source;
    }
  }

  if (validated.update_metadata !== undefined && typeof validated.update_metadata !== 'boolean') {
    logger.warn(`Invalid update_metadata value: ${validated.update_metadata}, defaulting to true`);
    validated.update_metadata = true;
  }

  // Must accept everything detectBackdropFocal() can produce — the
  // auto-detector emits the center-* variants too (I-6a).
  const validFocalValues = ['left', 'right', 'center', 'center-left', 'center-right', null];
  if (!validFocalValues.includes(validated.backdrop_focal)) {
    logger.warn(`Invalid backdrop_focal value: ${validated.backdrop_focal}, defaulting to null`);
    validated.backdrop_focal = null;
  }
  
  return validated;
}

/**
 * Create default TMDB configuration
 * @returns {Object} Default configuration
 */
function createDefaultConfig() {
  return {
    update_metadata: true,
    backdrop_focal: null
  };
}

/**
 * Check if metadata updates are allowed based on configuration
 * Matches Python script's is_metadata_update_allowed function
 * @param {Object} config - TMDB configuration object
 * @returns {boolean} Whether updates are allowed
 */
export function isUpdateAllowed(config) {
  return config.update_metadata !== false; // Default to true if not specified
}

/**
 * Get override value for image or metadata field
 * @param {Object} config - TMDB configuration object
 * @param {string} field - Field name to get override for (e.g., 'backdrop', 'poster', 'logo')
 * @returns {string|null} Override value or null if not set
 */
export function getOverride(config, field) {
  const overrideKey = `override_${field}`;
  return config[overrideKey] || null;
}

/**
 * Check if config has metadata overrides
 * @param {Object} config - TMDB configuration object
 * @returns {Object|null} Metadata overrides or null if not set
 */
export function getMetadataOverrides(config) {
  return config.metadata || null;
}

/**
 * Presence-based override opt-in check (G-2, decided 2026-07-07).
 *
 * Deliberately distinct from `getMetadataOverrides()` truthiness: a present
 * `metadata` key — even `{}` or `null` — is an explicit "this title is
 * override-managed" signal, while an absent key means overrides were never
 * opted into (or were reverted via the config endpoint's full-replace-on-omit
 * semantics — the A-2 contract, where omitting the key IS the revert).
 *
 * Any "is this title override-managed?" decision — the scanners'
 * frozen-metadata retry gate today, and the pristine-base merge/revert
 * semantics when they land — must call THIS, never a truthiness or
 * `Object.keys().length` check; both of those collapse `{}` and absent into
 * the same answer, which is exactly the ambiguity this helper exists to end.
 *
 * @param {Object} config - TMDB configuration object
 * @returns {boolean} Whether the `metadata` override key is present at all
 */
export function hasMetadataOverrideKey(config) {
  return !!config && typeof config === 'object' &&
         Object.prototype.hasOwnProperty.call(config, 'metadata');
}

/**
 * Apply metadata overrides to TMDB data
 * Matches Python script behavior for metadata updates
 * @param {Object} tmdbData - TMDB API response data
 * @param {Object} config - TMDB configuration object
 * @returns {Object} TMDB data with overrides applied
 */
export function applyMetadataOverrides(tmdbData, config) {
  const overrides = getMetadataOverrides(config);
  
  if (!overrides || typeof overrides !== 'object') {
    return tmdbData;
  }
  
  // Apply overrides by merging
  const result = {
    ...tmdbData,
    ...overrides
  };
  
  logger.debug(`Applied metadata overrides: ${Object.keys(overrides).join(', ')}`);
  return result;
}

/**
 * Get the path to tmdb.config file for a given media directory
 * @param {string} mediaPath - Path to media directory
 * @returns {string} Path to tmdb.config file
 */
export function getTmdbConfigFilePath(mediaPath) {
  return path.join(mediaPath, 'tmdb.config');
}
