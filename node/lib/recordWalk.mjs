/**
 * Rewrites the strings in a winston record, for the logger's redaction
 * formats (lib/webhookIdRedaction.mjs, lib/logSecrets.mjs).
 *
 * Copy on write: an object or array the caller still uses is never changed in
 * place (autoSync logs the very headers object it then sends). Only plain
 * objects and arrays are walked, to a fixed depth.
 */

const MAX_DEPTH = 8;

const isPlainObject = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * `value` with `transform(text, key)` applied to every string in it; `key` is
 * the property name the string sits under (null in an array).
 */
function mapStrings(value, transform, key, seen, depth) {
  if (typeof value === 'string') return transform(value, key);
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    let copy = null;
    value.forEach((item, index) => {
      const next = mapStrings(item, transform, null, seen, depth + 1);
      if (next !== item) {
        copy ??= [...value];
        copy[index] = next;
      }
    });
    return copy ?? value;
  }
  if (!isPlainObject(value)) return value;

  let copy = null;
  for (const [name, item] of Object.entries(value)) {
    const next = mapStrings(item, transform, name, seen, depth + 1);
    if (next !== item) {
      copy ??= { ...value };
      copy[name] = next;
    }
  }
  return copy ?? value;
}

/**
 * Applies `transform` to every string field of a winston record. The record's
 * top level is winston's own object, so assigning to it is safe.
 */
export function mapRecordStrings(info, transform) {
  const seen = new WeakSet();
  for (const key of Object.keys(info)) {
    const next = mapStrings(info[key], transform, key, seen, 0);
    if (next !== info[key]) info[key] = next;
  }
  return info;
}
