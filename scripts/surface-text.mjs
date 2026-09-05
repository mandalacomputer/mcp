/** The end of one quoted literal, or -1 when the literal is never closed. */
function quotedClose(text, from) {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      // What is inside `${...}` is code, not text: a nested template's backtick
      // and a string argument's quote close nothing at this level, and reading
      // one as if it did ends the literal early. Everything after that point is
      // then scanned in the wrong mode — a `//` becomes a comment inside what
      // was a string, a quote opens a literal that is not there — and the damage
      // runs on to the next accidental re-pairing rather than stopping at the
      // template.
      const hole = holeEnd(text, i + 1);
      if (hole === -1) return -1;
      i = hole;
    } else if (text[i] === quote) return i + 1;
  }
  return -1;
}

/** The `}` closing a `${` interpolation opened at `from`, or -1 if unclosed. */
function holeEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedClose(text, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Advance past one single-, double-, or backtick-quoted literal. */
function quotedEnd(text, from) {
  const end = quotedClose(text, from);
  return end === -1 ? text.length : end;
}

/** The identifier ending just before `end`, or '' where no identifier does. */
function identifierBefore(text, end) {
  // Bounded rather than `text.slice(0, end).match(/…$/)`, which copies the whole
  // prefix and scans it again for every slash inspected — quadratic in the file,
  // for an answer that never involves a character further back than the start of
  // one word.
  let i = end;
  while (i > 0 && /[\w$]/.test(text[i - 1])) i--;
  const word = text.slice(i, end);
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : '';
}

/** The `(` matching the `)` at `at`, or -1 when the walk runs off the front. */
function openerOf(text, at) {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && --depth === 0) return i;
  }
  return -1;
}

// A slash after one of these words begins a regex, because each of them is
// followed by an expression rather than by a value to divide. The four this
// began with covered `return /re/` and nothing else, so `typeof /re/.source`,
// `x in /re/`, `else /re/.test(s)` and the rest were read as division — and the
// first quote inside such a regex then opened a literal that swallowed whatever
// followed, comments included.
const REGEX_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'yield',
  'typeof',
  'in',
  'of',
  'instanceof',
  'new',
  'void',
  'delete',
  'do',
  'else',
]);

// The heads whose closing `)` is followed by a statement rather than by a value.
const STATEMENT_HEADS = new Set(['if', 'while', 'for']);

/** Whether a slash here can begin a regex literal rather than divide values. */
function regexCanStart(text, from) {
  let i = from - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  const ch = text[i];
  if ('([{=,:;!?&|~+*%^<>'.includes(ch)) return true;
  if (ch === ')') {
    // A `)` alone decides nothing: `(a + b) / c` divides, `if (ok) /re/.test(s)`
    // does not. What separates them is the word in front of the matching `(`, so
    // the paren is walked back to. The walk counts parens without regard for the
    // ones inside literals, so a `f(')')` on the way back finds the wrong opener
    // and the answer falls back to division — which is the safe direction of the
    // two: a regex read as division mis-scans to the end of the line, where a
    // division read as a regex can carry a phantom literal over code.
    const open = openerOf(text, i);
    if (open === -1) return false;
    let word = open - 1;
    while (word >= 0 && /\s/.test(text[word])) word--;
    return STATEMENT_HEADS.has(identifierBefore(text, word + 1));
  }
  // `]` closes an index or an array literal, both of them values, and no
  // statement head ends in one — so a slash after it divides. The residual case
  // is a regex written directly against a subscript (`parts[0] /re/.test(s)`),
  // which is read as division here; neither file this scans is written that way,
  // and there is no local evidence that would tell the two apart.
  if (ch === ']') return false;
  return REGEX_KEYWORDS.has(identifierBefore(text, i + 1));
}

/** Advance past a regex literal, including escaped delimiters and flags. */
function regexEnd(text, from) {
  let inClass = false;
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '[') inClass = true;
    else if (text[i] === ']') inClass = false;
    else if (text[i] === '/' && !inClass) {
      i++;
      while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
      return i;
    } else if (text[i] === '\n' || text[i] === '\r') {
      return from + 1;
    }
  }
  return from + 1;
}

const SHORT_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * The number one `\x`/`\u` escape spells.
 *
 * `Number.parseInt` answers NaN for digits that are not hex, and the two things
 * that consume it disagree about NaN in the worst two ways available:
 * `String.fromCharCode` returns NUL, so the bad escape becomes an invisible
 * character in the middle of a route pattern that then matches nothing, and
 * `String.fromCodePoint` throws a RangeError naming neither the file nor the
 * literal. What this reads is compiled TypeScript, so an escape that is not
 * well formed means the scanner was wrong about where the literal began or
 * ended — the same conclusion the unterminated `\u{` case draws, and worth
 * saying in the same words.
 */
function hexValue(digits, text) {
  if (!/^[0-9a-fA-F]+$/.test(digits)) {
    throw new Error(
      `malformed escape \\${digits} in ${JSON.stringify(text.slice(0, 60))} — the literal was read wrong`,
    );
  }
  return Number.parseInt(digits, 16);
}

/**
 * The text a quoted literal spells, with its escape sequences resolved.
 *
 * The walk that finds the literal is escape-aware and the read of it has to
 * be too, or the two disagree about where the value ends: `pattern: "a\"b"`
 * is one literal to `quotedClose` and the value `a"b`, but read raw it is the
 * two characters `a\` and a route the platform never served.
 */
function unescaped(text) {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      out += text[i];
      continue;
    }
    const next = text[++i];
    if (next === undefined) break;
    if (next === 'x') {
      out += String.fromCharCode(hexValue(text.slice(i + 1, i + 3), text));
      i += 2;
    } else if (next === 'u' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      // `indexOf` answers -1 for a `\u{` that is never closed, and `i = -1`
      // sends the loop back to the start of the string to meet the same escape
      // again — a hang rather than a bad character. What this reads is compiled
      // TypeScript, so an unclosed escape means this scanner was wrong about
      // where the literal ended; say so instead of spinning.
      if (end === -1) {
        throw new Error(
          `unterminated \\u{ escape in ${JSON.stringify(text.slice(0, 60))} — the literal was read wrong`,
        );
      }
      const code = hexValue(text.slice(i + 2, end), text);
      // Above the last code point there is no character to build, and the raw
      // RangeError says only that — not which literal, which is the half worth
      // knowing.
      if (code > 0x10ffff) {
        throw new Error(
          `code point \\u{${text.slice(i + 2, end)}} is out of range in ${JSON.stringify(text.slice(0, 60))}`,
        );
      }
      out += String.fromCodePoint(code);
      i = end;
    } else if (next === 'u') {
      out += String.fromCharCode(hexValue(text.slice(i + 1, i + 5), text));
      i += 4;
    } else {
      // Anything else stands for itself: `\'`, `\"`, `` \` ``, `\\`, `\$`.
      out += SHORT_ESCAPES[next] ?? next;
    }
  }
  return out;
}

/** Whether a template literal interpolates, as opposed to spelling `\${`. */
function hasHole(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '{') return true;
  }
  return false;
}

/** Escape a literal so it matches itself when interpolated into a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove comments without treating comment markers inside strings as syntax. */
export function stripComments(text) {
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedEnd(text, i);
      clean += text.slice(i, end);
      i = end - 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      const stop = end === -1 ? text.length : end;
      clean += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      clean += text.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = stop - 1;
    } else if (ch === '/' && regexCanStart(text, i)) {
      const end = regexEnd(text, i);
      clean += text.slice(i, end);
      i = end - 1;
    } else {
      clean += ch;
    }
  }
  return clean;
}

/** The text inside a balanced pair, ignoring delimiters in literals and comments. */
export function balanced(text, from, open, close) {
  // The caller's `indexOf` answers -1 for a delimiter that is not there, and -1
  // is a legal loop start: what came back was the text from offset 0 to whatever
  // closer turned up first, a slice that looks like an answer and is not one.
  // Every caller here computes `from` from a search, so the one thing worth
  // asserting is that the search found what it was looking for.
  if (text[from] !== open) {
    throw new Error(`balanced() started at offset ${from}, which is not a ${open}`);
  }
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(text, i) - 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === '/' && regexCanStart(text, i)) {
      i = regexEnd(text, i) - 1;
    } else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(from + 1, i);
  }
  throw new Error(`unbalanced ${open} from offset ${from}`);
}

/** The keys of an object literal at its own depth only. */
export function topLevelKeys(body) {
  const keys = [];
  // A key sits at the start of the object or just after a comma; nothing else
  // in an object literal is a key, whatever follows it. `tag: flag ? 'a' : 'b'`
  // puts a string in front of a colon and `flag ? a : b` puts an identifier
  // there, and neither names a field — but read as keys they become body fields
  // the mirror is told to grow, so the operator is sent to add a parameter that
  // does not exist. The body arrives here without its own braces, so offset 0 is
  // key position too.
  const inKeyPosition = (at) => {
    const before = body.slice(0, at).trimEnd();
    return before === '' || before.endsWith('{') || before.endsWith(',');
  };
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      // Valid source cannot close what it never opened, and the depth never
      // climbs back: every key after the stray closer is dropped, and what the
      // caller reads is an object with no fields rather than one it could not
      // parse. `entries` throws on the same condition for the same reason.
      if (--depth < 0) throw new Error(`unbalanced ${ch} at offset ${i}`);
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedEnd(body, i);
      // A quoted key is a key: `'name': str(…)` names the field `name` exactly
      // as `name:` does. Stepping over the literal without looking for the colon
      // reads the object as having no field there at all — and an object read as
      // having no fields is a route documenting no body, which matches a mirror
      // that lists none. That match is the vacuous all-clear this whole gate is
      // built to refuse.
      if (depth === 0 && inKeyPosition(i)) {
        const colon = body.slice(end).match(/^\s*:/);
        if (colon) {
          const inner = body.slice(i + 1, end - 1);
          // A computed key spelled with a hole in it names nothing this can
          // resolve; guessing at one would be worse than the key going unnamed.
          if (!(ch === '`' && hasHole(inner))) keys.push(unescaped(inner));
          i = end + colon[0].length;
          continue;
        }
      }
      i = end;
      continue;
    } else if (ch === '/' && regexCanStart(body, i)) {
      i = regexEnd(body, i);
      continue;
    }
    if (depth === 0 && inKeyPosition(i)) {
      const m = body.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (m) {
        keys.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return keys;
}

/**
 * The quoted value of one key of an object literal, at its own depth only.
 *
 * A sibling of `topLevelKeys`, and for the same reason: a route entry can nest
 * literals that carry keys of the same names — an options bag, a `handler: {}`
 * with a path in it — and a plain `/pattern:\s*'([^']+)'/` over the entry takes
 * whichever comes first rather than the entry's own. Returns undefined when the
 * key is not there at this depth, which is how a half-written entry is told
 * apart from a route.
 *
 * All three quote styles, because nothing about the table requires today's
 * spelling: a `pattern: "x"` read only for single quotes returns undefined,
 * the entry is dropped as half-written, and the route it named surfaces as a
 * platform that dropped a route it still serves.
 *
 * The literal is walked rather than matched, for the same reason the scan
 * around it is: a value alternation like `"[^"]*"` ends at the first quote
 * whether or not a backslash precedes it, so it disagrees with `quotedClose`
 * about which quote closes the literal and hands back a truncated value.
 */
export function topLevelField(body, name) {
  const at = new RegExp(`${escapeRegExp(name)}\\s*:\\s*`, 'y');
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      // As in `topLevelKeys`: a depth that goes negative never comes back, so
      // the rest of the entry is searched at a depth that says "nested" and the
      // field is reported missing rather than unreadable.
      if (--depth < 0) throw new Error(`unbalanced ${ch} at offset ${i}`);
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(body, i);
      continue;
    } else if (ch === '/' && regexCanStart(body, i)) {
      i = regexEnd(body, i);
      continue;
    }
    // Not mid-identifier: `submethod: 'x'` holds the letters of `method`, and a
    // sticky match started inside a longer word would read it as one.
    if (depth === 0 && !/[\w$]/.test(body[i - 1] ?? '')) {
      at.lastIndex = i;
      if (at.exec(body)) {
        const start = at.lastIndex;
        const quote = body[start];
        const end = quote === "'" || quote === '"' || quote === '`' ? quotedClose(body, start) : -1;
        // A value that is not a closed string literal is not this key's value.
        // Walking on rather than returning leaves the read where it was: the
        // key is only found where it is spelled the way the table spells it.
        if (end !== -1) {
          const inner = body.slice(start + 1, end - 1);
          // A template literal with a hole in it has no value to read here, and
          // guessing one would be worse than the undefined a half-written entry
          // already returns. An escaped `${` is not a hole — it is two of the
          // characters the pattern is spelled with, and dropping the entry over
          // it is the same false alarm in the other direction.
          if (quote === '`' && hasHole(inner)) return undefined;
          return unescaped(inner);
        }
      }
    }
    i++;
  }
  return undefined;
}

/**
 * Where the value of one top-level key starts, or -1 when the key is not there
 * at this depth.
 *
 * A sibling of `topLevelField` for the values it cannot read: the shape of a
 * value is what decides how it is read — `object(...)` has named fields, a raw
 * `{ type: 'string' }` schema has none to name, a bare identifier is a shape
 * this cannot read at all — and telling those apart with a regex over the whole
 * entry answers about whichever spelling turns up first at any depth. A
 * `body: { … }` quoted in a response example then vouches for the entry's own
 * `body: SHARED_BODY`, the unreadable shape passes as a readable one, and the
 * route is compared against no fields at all.
 *
 * Quoted spellings of the key as well, for the reason `topLevelKeys` reads them:
 * `'body':` names the same field as `body:` does, and a reader that insists on
 * one of them reports the other as absent.
 */
export function topLevelValueAt(body, name) {
  const lit = escapeRegExp(name);
  const key = new RegExp(`(?:'${lit}'|"${lit}"|${lit})\\s*:\\s*`, 'y');
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    // Before the literal skip below, so a quoted key is still seen; not
    // mid-identifier, as in `topLevelField`, so `subbody:` is not read as
    // `body:`.
    if (depth === 0 && !/[\w$]/.test(body[i - 1] ?? '')) {
      key.lastIndex = i;
      if (key.exec(body)) return key.lastIndex;
    }
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      // As in its siblings: a depth that goes negative never comes back, so the
      // key is reported missing rather than unreadable.
      if (--depth < 0) throw new Error(`unbalanced ${ch} at offset ${i}`);
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(body, i);
      continue;
    } else if (ch === '/' && regexCanStart(body, i)) {
      i = regexEnd(body, i);
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Each `{...}` of a list body, at the body's own depth.
 *
 * Literal-aware for the same reason `balanced` is, and it is not a nicety: a
 * lone brace inside any string, template or regex in the table — `note: 'the }
 * closer'` — moves a raw counter one step it should not take. One step is all
 * it costs. The depth never returns to zero on an entry boundary again, so no
 * later entry is ever emitted, and every route after the stray brace is
 * dropped. What the caller sees is a shorter list, not an error: `routes.size`
 * is still non-zero, so the guard for a parse that found nothing does not fire,
 * and the routes that went missing are reported as routes the platform dropped.
 * That is the false all-clear the entry split exists to prevent, arriving by
 * way of the split itself.
 *
 * Anything between the entries other than whitespace and commas is refused for
 * the same reason. A `...SHARED` spread, or a list built by concatenation, holds
 * routes this walk cannot see; emitting the entries around it hands back a table
 * that is short by however many the spread carried, and those surface as routes
 * the mirror invented rather than as a list nobody read whole.
 */
export function entries(body) {
  const out = [];
  let depth = 0;
  let from = 0;
  let i = 0;
  const stray = (at) =>
    new Error(
      `unexpected ${JSON.stringify(body.slice(at, at + 40))} at offset ${at}: a list element that is not an object literal`,
    );
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      if (depth === 0) throw stray(i);
      i = quotedEnd(body, i);
      continue;
    }
    if (ch === '/' && body[i + 1] === '/') {
      const end = body.indexOf('\n', i + 2);
      i = end === -1 ? body.length : end;
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      i = end === -1 ? body.length : end + 2;
      continue;
    }
    if (ch === '/' && regexCanStart(body, i)) {
      if (depth === 0) throw stray(i);
      i = regexEnd(body, i);
      continue;
    }
    if (ch === '{') {
      if (depth++ === 0) from = i;
    } else if (ch === '}') {
      // Valid source cannot close a brace it never opened, and the recovery for
      // one is the bug above: throwing says so instead of returning a short list
      // that reads like a table which lost some routes.
      if (depth === 0) throw new Error(`unbalanced } at offset ${i}`);
      if (--depth === 0) out.push(body.slice(from + 1, i));
    } else if (depth === 0 && !/[\s,]/.test(ch)) throw stray(i);
    i++;
  }
  if (depth !== 0) throw new Error('unbalanced { in list body');
  return out;
}
