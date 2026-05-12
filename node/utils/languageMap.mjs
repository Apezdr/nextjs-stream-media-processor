/**
 * Single source of truth for ISO 639 language code ↔ display name mapping.
 * Both 2-letter (639-1) and 3-letter (639-2/B and /T) codes are accepted.
 */
export const langMap = {
  en: "English", eng: "English",
  es: "Spanish", spa: "Spanish",
  tl: "Tagalog", tgl: "Tagalog",
  zh: "Chinese", zho: "Chinese", chi: "Chinese",
  cs: "Czech", cze: "Czech",
  da: "Danish", dan: "Danish",
  nl: "Dutch", dut: "Dutch",
  fi: "Finnish", fin: "Finnish",
  fr: "French", fre: "French",
  de: "German", ger: "German",
  el: "Greek", gre: "Greek",
  hu: "Hungarian", hun: "Hungarian",
  it: "Italian", ita: "Italian",
  ja: "Japanese", jpn: "Japanese",
  ko: "Korean", kor: "Korean",
  no: "Norwegian", nor: "Norwegian",
  pl: "Polish", pol: "Polish",
  pt: "Portuguese", por: "Portuguese",
  ro: "Romanian", ron: "Romanian", rum: "Romanian",
  sk: "Slovak", slo: "Slovak",
  sv: "Swedish", swe: "Swedish",
  tr: "Turkish", tur: "Turkish",
  ar: "Arabic", ara: "Arabic",
  bg: "Bulgarian", bul: "Bulgarian",
  et: "Estonian", est: "Estonian",
  he: "Hebrew", heb: "Hebrew",
  hi: "Hindi", hin: "Hindi",
  id: "Indonesian", ind: "Indonesian",
  lv: "Latvian", lav: "Latvian",
  lt: "Lithuanian", lit: "Lithuanian",
  ms: "Malay", may: "Malay",
  ru: "Russian", rus: "Russian",
  sl: "Slovenian", slv: "Slovenian",
  ta: "Tamil", tam: "Tamil",
  te: "Telugu", tel: "Telugu",
  th: "Thai", tha: "Thai",
  uk: "Ukrainian", ukr: "Ukrainian",
  vi: "Vietnamese", vie: "Vietnamese",
};

// Built once: language-name (lowercased) → preferred 2-letter code.
const nameToTwoLetter = (() => {
  const m = {};
  for (const [code, name] of Object.entries(langMap)) {
    if (code.length === 2) m[name.toLowerCase()] = code;
  }
  return m;
})();

/**
 * Coerce any langMap-known code (2- or 3-letter) to its preferred 2-letter form.
 * Unknown codes and codes without a 2-letter equivalent pass through unchanged.
 */
export function canonicalizeLangCode(rawCode) {
  if (!rawCode) return rawCode;
  if (rawCode.length === 2 && langMap[rawCode]) return rawCode;
  const name = langMap[rawCode];
  if (!name) return rawCode;
  return nameToTwoLetter[name.toLowerCase()] || rawCode;
}

/**
 * Resolve a display name (optionally suffixed with " Hearing Impaired" or
 * " - Auto Generated") to its 2-letter code, or null if unknown.
 */
export function getLanguageCode(languageName) {
  if (!languageName) return null;
  const cleanName = languageName
    .replace(/\s*-\s*auto\s+generated\s*$/i, '')
    .replace(/\s+hearing\s+impaired\s*$/i, '')
    .trim();
  return nameToTwoLetter[cleanName.toLowerCase()] || null;
}
