/**
 * getLanguageName: the admin process list says "English", not "en".
 */
import { describe, it, expect } from '@jest/globals';
import { getLanguageName } from '../../../utils/languageMap.mjs';

describe('getLanguageName', () => {
  it('names the codes langMap knows, two- and three-letter alike', () => {
    expect(getLanguageName('en')).toBe('English');
    expect(getLanguageName('eng')).toBe('English');
    expect(getLanguageName('ES')).toBe('Spanish');
    expect(getLanguageName('ger')).toBe('German');
  });

  it("falls back to the runtime's names for a code langMap lacks", () => {
    expect(getLanguageName('pt-BR')).toBe('Brazilian Portuguese');
  });

  it('passes an unknown code through unchanged', () => {
    expect(getLanguageName('xx')).toBe('xx');
    expect(getLanguageName('')).toBe('');
    expect(getLanguageName(null)).toBe(null);
  });
});
