// In-repo replacement for natural's WordTokenizer + PorterStemmer (Phase 7, 2026-08-17): the
// only usage in this codebase is contextInjector.js's keyword file-matching, which never
// needed the full natural dependency tree (wordnet data, classifiers, etc.). This is a
// faithful port of natural's porter_stemmer.js / WordTokenizer (MIT, Chris Umbel) — the
// algorithm and edge cases are identical so keyword-match output cannot shift, which
// check-matcher's context-injection rows depend on. Ported from natural@8.1.1.

// Group consecutive consonants as C and consecutive vowels as V.
function categorizeGroups(token) {
  return token.replace(/[^aeiouy]+y/g, 'CV').replace(/[aeiou]+/g, 'V').replace(/[^V]+/g, 'C');
}

// Denote single consonants with C and single vowels with V.
function categorizeChars(token) {
  return token.replace(/[^aeiouy]y/g, 'CV').replace(/[aeiou]/g, 'V').replace(/[^V]/g, 'C');
}

// The "measure" M of a word: count of VC sequences, dropping an initial C and a trailing V.
function measure(token) {
  if (!token) return -1;
  return categorizeGroups(token).replace(/^C/, '').replace(/V$/, '').length / 2;
}

function endsWithDoublCons(token) {
  return token.match(/([^aeiou])\1$/);
}

function attemptReplace(token, pattern, replacement, callback) {
  let result = null;
  if (typeof pattern === 'string' && token.substr(0 - pattern.length) === pattern) {
    result = token.replace(new RegExp(pattern + '$'), replacement);
  } else if (pattern instanceof RegExp && token.match(pattern)) {
    result = token.replace(pattern, replacement);
  }
  if (result && callback) return callback(result);
  return result;
}

function attemptReplacePatterns(token, replacements, measureThreshold) {
  let replacement = token;
  for (let i = 0; i < replacements.length; i++) {
    if (measureThreshold == null || measure(attemptReplace(token, replacements[i][0], replacements[i][1])) > measureThreshold) {
      replacement = attemptReplace(replacement, replacements[i][0], replacements[i][2]) || replacement;
    }
  }
  return replacement;
}

function replacePatterns(token, replacements, measureThreshold) {
  return attemptReplacePatterns(token, replacements, measureThreshold) || token;
}

function replaceRegex(token, regex, includeParts, minimumMeasure) {
  let parts;
  let result = '';
  if (regex.test(token)) {
    parts = regex.exec(token);
    includeParts.forEach((i) => {
      result += parts[i];
    });
  }
  if (measure(result) > minimumMeasure) return result;
  return null;
}

function step1a(token) {
  if (token.match(/(ss|i)es$/)) {
    return token.replace(/(ss|i)es$/, '$1');
  }
  if (token.substr(-1) === 's' && token.substr(-2, 1) !== 's' && token.length > 2) {
    return token.replace(/s?$/, '');
  }
  return token;
}

function step1b(token) {
  let result;
  if (token.substr(-3) === 'eed') {
    if (measure(token.substr(0, token.length - 3)) > 0) return token.replace(/eed$/, 'ee');
  } else {
    result = attemptReplace(token, /(ed|ing)$/, '', (t) => {
      if (categorizeGroups(t).indexOf('V') >= 0) {
        result = attemptReplacePatterns(t, [['at', '', 'ate'], ['bl', '', 'ble'], ['iz', '', 'ize']]);
        if (result !== t) {
          return result;
        }
        if (endsWithDoublCons(t) && t.match(/[^lsz]$/)) {
          return t.replace(/([^aeiou])\1$/, '$1');
        }
        if (measure(t) === 1 && categorizeChars(t).substr(-3) === 'CVC' && t.match(/[^wxy]$/)) {
          return t + 'e';
        }
        return t;
      }
      return null;
    });
    if (result) return result;
  }
  return token;
}

function step1c(token) {
  const grouped = categorizeGroups(token);
  if (token.substr(-1) === 'y' && grouped.substr(0, grouped.length - 1).indexOf('V') > -1) {
    return token.replace(/y$/, 'i');
  }
  return token;
}

function step2(token) {
  return replacePatterns(token, [['ational', '', 'ate'], ['tional', '', 'tion'], ['enci', '', 'ence'], ['anci', '', 'ance'],
    ['izer', '', 'ize'], ['abli', '', 'able'], ['bli', '', 'ble'], ['alli', '', 'al'], ['entli', '', 'ent'], ['eli', '', 'e'],
    ['ousli', '', 'ous'], ['ization', '', 'ize'], ['ation', '', 'ate'], ['ator', '', 'ate'], ['alism', '', 'al'],
    ['iveness', '', 'ive'], ['fulness', '', 'ful'], ['ousness', '', 'ous'], ['aliti', '', 'al'],
    ['iviti', '', 'ive'], ['biliti', '', 'ble'], ['logi', '', 'log']], 0);
}

function step3(token) {
  return replacePatterns(token, [['icate', '', 'ic'], ['ative', '', ''], ['alize', '', 'al'],
    ['iciti', '', 'ic'], ['ical', '', 'ic'], ['ful', '', ''], ['ness', '', '']], 0);
}

function step4(token) {
  return replaceRegex(token, /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/, [1], 1) ||
    replaceRegex(token, /^(.+?)(s|t)(ion)$/, [1, 2], 1) ||
    token;
}

function step5a(token) {
  const m = measure(token.replace(/e$/, ''));
  if (m > 1 || (m === 1 && !(categorizeChars(token).substr(-4, 3) === 'CVC' && token.match(/[^wxy].$/)))) {
    token = token.replace(/e$/, '');
  }
  return token;
}

function step5b(token) {
  if (measure(token) > 1) return token.replace(/ll$/, 'l');
  return token;
}

/** Porter 1980 stem of a single word — same algorithm and edge cases as natural's. */
export function stem(token) {
  if (token.length < 3) return token.toString();
  return step5b(step5a(step4(step3(step2(step1c(step1b(step1a(token.toLowerCase())))))))).toString();
}

// natural's WordTokenizer splits on any run of non-word characters; empty and single-space
// tokens are discarded (same gap-split + _.without behaviour). natural's source declares extra
// non-ASCII ranges (Latin-1 ×/÷, the Arabic block), but its installed build only keeps
// [A-Za-z0-9_] — verified empirically: ä ö ü ß × ÷ and Arabic letters all split. The port
// mirrors the installed behaviour so German/other-language phrases tokenize identically.
const WORD_SPLIT_RE = /[^A-Za-z0-9_]+/;

export function tokenize(text) {
  return text.split(WORD_SPLIT_RE).filter((t) => t && t !== ' ');
}