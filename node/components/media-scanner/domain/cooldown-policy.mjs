/**
 * Post-attempt cooldown decision for the `missing_data_media` table, shared by
 * the movie and TV scanners so the mark/clear table cannot drift between them.
 *
 * Pure function — inputs are the post-attempt disk state, the generator's
 * frozen verdict (via `isFrozenReason()` on the returned reason), and whether
 * tmdb.config carries metadata overrides. Decision table:
 *
 *  - metadata still missing + frozen with NO overrides  → 'clear'
 *      Paused is not failing. The scanners' metadata gate does not re-open for
 *      a frozen no-overrides title (see the gate comments in the scanners), so
 *      clearing cannot loop; it just guarantees no stale cooldown survives an
 *      unfreeze (which is picked up via dirHashChanged the tick the operator
 *      edits tmdb.config).
 *  - metadata still missing + frozen WITH overrides     → 'mark'
 *      Overrides keep the metadata gate open (so _applyOverridesWhileFrozen can
 *      run), but a merge that changes nothing would otherwise re-invoke the
 *      generator every tick forever (e.g. overrides already applied but
 *      metadata.json still stale-by-config). Marking paces that at the 24h
 *      cooldown, same as any other unresolved attempt.
 *  - metadata still missing, not frozen                 → 'mark'
 *      'no-match' / 'transient-error' / any real failure: the 24h cooldown now
 *      means confirmed failure (the mark happens after the attempt, not before).
 *  - metadata present + images present                  → 'clear'
 *      Fully resolved.
 *  - metadata present + images still missing            → 'none'
 *      Any existing metadata cooldown row is irrelevant to the images path,
 *      which retries on its own `missingImages && updateAllowed` gate.
 *
 * The caller is expected to skip a 'clear' when it already knows no row exists
 * (avoids a no-op DELETE per tick) and to do nothing at all when the generator
 * was not invoked this tick.
 *
 * @param {Object} state
 * @param {boolean} state.metadataStillMissing - post-attempt `missingMetadata`
 * @param {boolean} state.imagesStillMissing - post-attempt `missingImages`
 * @param {boolean} state.frozen - `isFrozenReason(result.reason)`
 * @param {boolean} state.hasOverrides - tmdb.config has a `metadata` overrides block
 * @returns {'mark'|'clear'|'none'}
 */
export function resolveCooldownAction({ metadataStillMissing, imagesStillMissing, frozen, hasOverrides }) {
  if (metadataStillMissing) {
    return (frozen && !hasOverrides) ? 'clear' : 'mark';
  }
  return imagesStillMissing ? 'none' : 'clear';
}
