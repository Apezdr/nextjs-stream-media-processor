/**
 * The one list of identity providers the processor knows how to build.
 *
 * Adding an integration is one import and one array entry here. Order is
 * precedence: when two providers claim the same folder with different ids,
 * the earlier one wins and the disagreement is reported (index-builder.mjs).
 * A provider is enabled purely by its own env being present — there is no
 * master switch, so "nothing configured" is byte-for-byte today's behaviour.
 */

import { RadarrProvider } from './arr/radarr.mjs';
import { SonarrProvider } from './arr/sonarr.mjs';
import { IDENTITY_SOURCE_MANUAL, UNSOURCED_PIN_TREATMENTS } from '../../utils/tmdbConfig.mjs';

export const PROVIDER_CLASSES = Object.freeze([
  RadarrProvider,
  SonarrProvider,
]);

/**
 * Instantiate every configured provider.
 * @param {Object} env
 * @param {Object} [deps] passed to each class's fromEnv (fetchImpl, logger)
 * @returns {{providers: import('./provider.mjs').IdentityProvider[], errors: Array<{provider: string, error: string}>}}
 */
export function createIdentityProviders(env = process.env, deps = {}) {
  const providers = [];
  const errors = [];
  const seen = new Set();
  for (const ProviderClass of PROVIDER_CLASSES) {
    const label = ProviderClass.providerName ?? ProviderClass.name;
    try {
      const provider = ProviderClass.fromEnv(env, deps);
      if (!provider) continue;
      if (seen.has(provider.name)) {
        throw new Error(`duplicate identity provider name '${provider.name}'`);
      }
      seen.add(provider.name);
      providers.push(provider);
    } catch (error) {
      errors.push({ provider: label, error: error.message });
      deps.logger?.error(`identity: provider '${label}' is misconfigured and was skipped: ${error.message}`);
    }
  }
  return { providers, errors };
}

/**
 * IDENTITY_UNSOURCED_PINS → a validated treatment. Unknown values fall back to
 * `manual` with a warning; silently widening the overwrite rule is not an
 * acceptable failure mode for a typo.
 * @param {string|undefined} raw
 * @param {Object} [logger]
 * @returns {'manual'|'auto'}
 */
export function parseUnsourcedPinTreatment(raw, logger = null) {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return IDENTITY_SOURCE_MANUAL;
  if (UNSOURCED_PIN_TREATMENTS.includes(value)) return value;
  logger?.warn(`identity: IDENTITY_UNSOURCED_PINS='${raw}' is not one of ${UNSOURCED_PIN_TREATMENTS.join('|')}; using manual`);
  return IDENTITY_SOURCE_MANUAL;
}
