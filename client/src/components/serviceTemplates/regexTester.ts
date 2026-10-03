/**
 * Live regex tester for custom service templates (browser side).
 *
 * The agent compiles custom regexes with Go's `regexp` package (RE2 syntax,
 * Go 1.22): no lookarounds, no backreferences, no atomic groups, repeat
 * counts up to 1000. The browser runs JavaScript regexes, so a pattern is
 * (1) checked for constructs RE2 rejects — those are refused before saving,
 * since the agent would drop the template — and (2) translated to an
 * equivalent JavaScript regex for the preview when that is possible
 * (`(?P<name>…)`, leading `(?i)` flags, `\A` / `\z`, `\Q…\E`, POSIX classes).
 *
 * Kept free of runtime imports: the verification harness transpiles and
 * evaluates this module on its own.
 */

/** A construct Go RE2 does not support (the agent would refuse the regex). */
export type Re2IssueCode =
  | 'lookahead'
  | 'lookbehind'
  | 'backreference'
  | 'namedBackreference'
  | 'atomicGroup'
  | 'conditional'
  | 'recursion'
  | 'repeatCount'
  | 'unbalanced'
  /** An escape Go does not know (\Z, \G, \e, \u…), or a trailing backslash. */
  | 'escape'
  /** A (?…) group form Go does not know ((?#…), (?|…), …). */
  | 'group';

export interface Re2Issue {
  code: Re2IssueCode;
  /** Index in the pattern where the construct starts. */
  index: number;
  /** The offending text (for display). */
  text: string;
}

/** RE2 repetition limit ({n,m} with n or m above it is a compile error in Go). */
export const RE2_MAX_REPEAT = 1000;

const OCTAL = /[0-7]/;
const DIGIT = /[0-9]/;
/** Letters Go accepts after a backslash outside a class (digits are handled apart). */
const ESCAPES_OUTSIDE = new Set('AbBdDsSwWpPzxafnrtv'.split(''));
/** Inside a class: no \A, \b, \B, \z. */
const ESCAPES_INSIDE = new Set('dDsSwWpPxafnrtv'.split(''));
/** Flag group: (?i) (?-s) (?im:…) — Go flags are i, m, s, U. */
const FLAG_GROUP = /^[imsU-]+[:)]/;

/**
 * Constructs of `pattern` that Go RE2 rejects. Escapes and character classes
 * are skipped, so `\(?=` or `[(?=]` are not reported.
 */
export function findRe2Issues(pattern: string): Re2Issue[] {
  const issues: Re2Issue[] = [];
  let depth = 0;
  let inClass = false;
  let classStart = -1;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (next === 'Q') {
        // \Q...\E literal text (also inside a class).
        const end = pattern.indexOf('\\E', i + 2);
        i = end < 0 ? pattern.length : end + 2;
        continue;
      }
      if (next === '') {
        issues.push({ code: 'escape', index: i, text: '\\' });
        i += 1;
        continue;
      }
      // \1-\7 not followed by another octal digit is a backreference (\12, \0
      // and \012 are octal character codes in RE2); \8 and \9 are never
      // octal. Go refuses both, inside a class too.
      if ((next >= '1' && next <= '7' && !OCTAL.test(pattern[i + 2] ?? '')) || next === '8' || next === '9') {
        issues.push({ code: 'backreference', index: i, text: pattern.slice(i, i + 2) });
      } else if (!inClass && next === 'k' && /[<{']/.test(pattern[i + 2] ?? '')) {
        const close = { '<': '>', '{': '}', "'": "'" }[pattern[i + 2] as '<' | '{' | "'"];
        const end = pattern.indexOf(close, i + 3);
        issues.push({ code: 'namedBackreference', index: i, text: pattern.slice(i, end < 0 ? i + 3 : end + 1) });
      } else if (!inClass && next === 'g' && /[{<0-9-]/.test(pattern[i + 2] ?? '')) {
        issues.push({ code: 'backreference', index: i, text: pattern.slice(i, i + 3) });
      } else if (/[A-Za-z]/.test(next) && !(inClass ? ESCAPES_INSIDE : ESCAPES_OUTSIDE).has(next)) {
        // Go: an escaped ASCII letter must be a known escape (compile error otherwise).
        issues.push({ code: 'escape', index: i, text: pattern.slice(i, i + 2) });
      } else if (next.charCodeAt(0) > 0x7f) {
        // Go only takes escaped ASCII punctuation as a literal.
        issues.push({ code: 'escape', index: i, text: pattern.slice(i, i + 2) });
      }
      i += 2;
      continue;
    }
    if (inClass) {
      if (pattern.startsWith('[:', i)) {
        const end = pattern.indexOf(':]', i + 2);
        if (end >= 0) { i = end + 2; continue; }
      }
      // A ']' right after '[' or '[^' is a literal.
      if (c === ']' && i > classStart + 1 && !(i === classStart + 2 && pattern[classStart + 1] === '^')) {
        inClass = false;
      }
      i += 1;
      continue;
    }
    if (c === '[') {
      inClass = true;
      classStart = i;
      i += 1;
      continue;
    }
    if (c === '(') {
      depth += 1;
      if (pattern[i + 1] === '?') {
        const rest = pattern.slice(i + 2);
        const groupText = (n: number) => pattern.slice(i, i + 2 + n);
        if (rest.startsWith('=') || rest.startsWith('!')) {
          issues.push({ code: 'lookahead', index: i, text: groupText(1) });
        } else if (rest.startsWith('<=') || rest.startsWith('<!')) {
          issues.push({ code: 'lookbehind', index: i, text: groupText(2) });
        } else if (rest.startsWith('>')) {
          issues.push({ code: 'atomicGroup', index: i, text: groupText(1) });
        } else if (rest.startsWith('(')) {
          issues.push({ code: 'conditional', index: i, text: groupText(1) });
        } else if (rest.startsWith('P=')) {
          const end = pattern.indexOf(')', i);
          issues.push({ code: 'namedBackreference', index: i, text: pattern.slice(i, end < 0 ? pattern.length : end + 1) });
        } else if (rest.startsWith('P>') || rest.startsWith('R') || DIGIT.test(rest[0] ?? '') || rest.startsWith('&')) {
          issues.push({ code: 'recursion', index: i, text: groupText(2) });
        } else if (!(rest.startsWith(':') || rest.startsWith('P<') || rest.startsWith('<') || FLAG_GROUP.test(rest))) {
          issues.push({ code: 'group', index: i, text: groupText(1) });
        }
      }
      i += 1;
      continue;
    }
    if (c === ')') {
      depth -= 1;
      if (depth < 0) {
        issues.push({ code: 'unbalanced', index: i, text: ')' });
        depth = 0;
      }
      i += 1;
      continue;
    }
    if (c === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        const lo = Number(m[1]);
        const hi = m[2] ? Number(m[2]) : lo;
        if (lo > RE2_MAX_REPEAT || hi > RE2_MAX_REPEAT) {
          issues.push({ code: 'repeatCount', index: i, text: m[0] });
        }
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  if (depth > 0) issues.push({ code: 'unbalanced', index: pattern.length, text: '(' });
  return issues;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: '\\t ',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-\\/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

export type JsRegexResult =
  | { ok: true; regex: RegExp }
  /** `untranslatable`: valid Go syntax the browser cannot preview; `invalid`: a syntax error. */
  | { ok: false; reason: 'untranslatable' | 'invalid'; message: string };

/**
 * The JavaScript equivalent of a Go regex, for the in-browser preview.
 * Call findRe2Issues first: RE2-only rejections are not reported here.
 */
export function toJsRegex(pattern: string): JsRegexResult {
  let flags = '';
  let src = pattern;
  // Leading flag group: (?i) (?s) (?m) (?is) …; ungreedy (U) has no JS equivalent.
  const lead = /^\(\?([imsU]+)\)/.exec(src);
  if (lead) {
    if (lead[1].includes('U')) {
      return { ok: false, reason: 'untranslatable', message: '(?U)' };
    }
    flags = [...new Set(lead[1].split(''))].join('');
    src = src.slice(lead[0].length);
  }

  let out = '';
  let inClass = false;
  let classStart = -1;
  let scopedFlags: string | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (next === 'Q') {
        const end = src.indexOf('\\E', i + 2);
        const literal = src.slice(i + 2, end < 0 ? src.length : end);
        out += escapeLiteral(literal);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      if (!inClass && next === 'A') { out += '^'; i += 2; continue; }
      if (!inClass && next === 'z') { out += '$'; i += 2; continue; }
      if (next === 'p' || next === 'P' || next === 'C') {
        return { ok: false, reason: 'untranslatable', message: src.slice(i, i + 2) };
      }
      if (next === 'x' && src[i + 2] === '{') {
        // Go \x{HHHH}; JS (no u flag) only has \uHHHH.
        const m = /^\\x\{([0-9A-Fa-f]{1,6})\}/.exec(src.slice(i));
        const code = m ? parseInt(m[1], 16) : NaN;
        if (!m || code > 0xffff) {
          return { ok: false, reason: 'untranslatable', message: m ? m[0] : src.slice(i, i + 3) };
        }
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        i += m[0].length;
        continue;
      }
      out += c + next;
      i += 2;
      continue;
    }
    if (inClass) {
      if (src.startsWith('[:', i)) {
        const end = src.indexOf(':]', i + 2);
        if (end >= 0) {
          const name = src.slice(i + 2, end);
          const mapped = POSIX_CLASSES[name];
          if (!mapped) return { ok: false, reason: 'untranslatable', message: `[:${name}:]` };
          out += mapped;
          i = end + 2;
          continue;
        }
      }
      if (c === ']' && i > classStart + 1 && !(i === classStart + 2 && src[classStart + 1] === '^')) {
        inClass = false;
      } else if (c === '[') {
        // A literal '[' inside a class must be escaped in JS (v-mode safety).
        out += '\\[';
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === '[') {
      inClass = true;
      classStart = i;
      out += c;
      // ']' first in the class is a literal in Go, an empty class in JS.
      if (src[i + 1] === ']') { out += '\\]'; i += 2; continue; }
      if (src[i + 1] === '^' && src[i + 2] === ']') { out += '^\\]'; i += 3; continue; }
      i += 1;
      continue;
    }
    if (c === '(' && src[i + 1] === '?') {
      if (src.startsWith('(?P<', i)) { out += '(?<'; i += 4; continue; }
      // A flag group in the middle of the pattern ((?i) not at the start).
      if (/^\(\?[imsU-]+\)/.test(src.slice(i))) {
        const m = /^\(\?[imsU-]+\)/.exec(src.slice(i))!;
        return { ok: false, reason: 'untranslatable', message: m[0] };
      }
      // Scoped flags (?i:…): recent JS engines accept them (not U), older ones
      // do not; then only the preview is unavailable.
      const scoped = /^\(\?[imsU-]+:/.exec(src.slice(i));
      if (scoped) {
        if (scoped[0].includes('U')) return { ok: false, reason: 'untranslatable', message: scoped[0] };
        scopedFlags = scopedFlags ?? scoped[0];
      }
    }
    out += c;
    i += 1;
  }

  try {
    return { ok: true, regex: new RegExp(out, flags) };
  } catch (err) {
    if (scopedFlags) return { ok: false, reason: 'untranslatable', message: scopedFlags };
    return { ok: false, reason: 'invalid', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Names of the named groups of a Go pattern ((?P<name>…) and (?<name>…)). */
export function namedGroups(pattern: string): string[] {
  const names: string[] = [];
  const re = /\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    // Skip an escaped paren (\(?P<x>) — not a group.
    let backslashes = 0;
    for (let k = m.index - 1; k >= 0 && pattern[k] === '\\'; k--) backslashes++;
    if (backslashes % 2 === 0) names.push(m[1]);
  }
  return names;
}

export interface SampleLineResult {
  line: string;
  matched: boolean;
  /** Captured `ip` group ('' when the group did not participate). */
  ip: string | null;
  /** Captured `username` group. */
  username: string | null;
  /** [start, end) of the whole match in the line, for highlighting. */
  span: [number, number] | null;
}

/**
 * Runs the (translated) regex on each non-empty sample line, the way the agent
 * does: first match of the line, `ip` and `username` named groups.
 */
export function runSamples(regex: RegExp, text: string, maxLines = 200): SampleLineResult[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, maxLines);
  // A fresh, non-global copy: lastIndex never carries over between lines.
  const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
  return lines.map((line) => {
    const m = re.exec(line);
    if (!m) return { line, matched: false, ip: null, username: null, span: null };
    const groups = m.groups ?? {};
    return {
      line,
      matched: true,
      ip: groups.ip ?? null,
      username: groups.username ?? null,
      span: [m.index, m.index + m[0].length],
    };
  });
}

/** Loose IPv4 / IPv6 shape check of a captured `ip` (the agent validates strictly). */
export function looksLikeIp(value: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(value)) {
    return value.split('.').every((p) => Number(p) <= 255);
  }
  return value.includes(':') && /^[0-9A-Fa-f:.]+$/.test(value);
}
