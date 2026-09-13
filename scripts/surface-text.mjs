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

// Words that are not values, so a slash after one begins a regex rather than
// dividing. Spelled as every reserved and contextual word there is rather than
// as the ones a regex is known to follow, because the two mistakes do not cost
// the same: a word wrongly listed here reads a division as a regex and
// mis-scans to the end of the line, while a word left out reads a regex as a
// division and walks into its body, where the first quote opens a literal that
// swallows whatever follows and a `}` closes a scope nobody opened.
//
// Enumerating the openers is how this list reached `else` and stopped: the
// Python SDK's reader, ported from this one, was found treating `export
// default /…/` and `class C extends /…/` as arithmetic, and the first of those
// carried a whole route table inside a regex and had it read as the real one.
// The five reserved words that ARE values — `this`, `super`, `true`, `false`
// and `null` — are deliberately absent.
const NOT_A_VALUE = new Set([
  'abstract',
  'as',
  'asserts',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'namespace',
  'new',
  'of',
  'out',
  'override',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'static',
  'switch',
  'throw',
  'try',
  'type',
  'typeof',
  'unique',
  'var',
  'void',
  'while',
  'with',
  'yield',
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
  return NOT_A_VALUE.has(identifierBefore(text, i + 1));
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
    } else if (next === '\n' || next === '\u2028' || next === '\u2029') {
      // A line continuation spells NOTHING. `'si\<newline>zes'` is `sizes` to the
      // engine, and a reader that kept the newline compared a route with a line
      // break in it — reporting the real one missing and inventing one nobody
      // serves.
    } else if (next === '\r') {
      // CRLF is one terminator. Swallow the LF with it, or the value keeps a
      // newline the engine never put there.
      if (text[i + 1] === '\n') i++;
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
      const stop = lineCommentEnd(text, i + 2);
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
/**
 * Where a `//` comment ends: the next LINE TERMINATOR, all four of them.
 *
 * JavaScript ends a line comment at CR, LF, U+2028 or U+2029, and every scanner in
 * this file used to look for LF alone. That is not a nicety: a comment ended by a
 * CR left the rest of a physical line looking like comment to this reader while the
 * engine had gone back to reading code — `([m, p]: Route, //<CR> _i, { [++(p as any)]: u }<LF>)`
 * passed the parameter count and returned `GET NaN` at runtime (review of
 * OPL-4830). A scanner that agrees with the engine about where a comment stops is
 * the only way the counting means anything.
 *
 * Returns the length of the text when the comment runs to the end.
 */
function lineCommentEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') return i;
  }
  return text.length;
}

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
      i = lineCommentEnd(text, i + 2);
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

/**
 * The keys of an object literal at its own depth only, or a throw for one it
 * cannot account for.
 *
 * EVERY key, which is the whole of what the caller needs: this is what reads a
 * route's body fields, and a field it cannot see is a field the comparison does
 * not make. Under-reading has no symptom of its own — the mirror listing the
 * field is reported as having invented it, and a mirror written by somebody who
 * missed it too agrees with this reader about nothing at all. A body read as
 * having no fields is a route documenting no body, and the check then passes on
 * a shape it did not analyse, which is the one outcome this gate exists to make
 * impossible.
 *
 * So the shapes that carry fields this cannot resolve are refused rather than
 * walked past: a spread, whose fields are somewhere else entirely; a key
 * computed from an identifier; a key interpolated into a template. Each was
 * silently nothing, and a silent nothing here is indistinguishable from a
 * literal with no fields in it. `entries` and `objectFields` already refuse the
 * same three for the same reason (OPL-4812).
 *
 * One shape stays unread rather than refused: shorthand, `{ name }`. It is the
 * one key form with no colon to confirm it, and the position it sits in is a
 * position this reader cannot establish is a key — an identifier one character
 * after a comma at depth 0 is equally a type argument, and reading `B` out of
 * `make<A, B>()` would report a field the platform does not document. Refusing
 * it instead would fail the check over a valid value. Neither is worth it for a
 * spelling nothing on the far side uses; if one appears, this will under-read by
 * that field and the comparison will say the mirror invented it.
 */
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
  const seen = (at) => JSON.stringify(body.slice(at, at + 40));
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    // Key position is decided BEFORE the walk below, because one of the shapes
    // refused here is opened by a character that walk would rather count: a
    // computed key's `[` was depth, so its contents were read as a nested
    // literal and the key was never seen at key position at all.
    //
    // Whitespace is not a key and not a shape: the position after a comma is
    // spaces before it is anything, and classifying one of those would refuse
    // every object with a line break in it.
    //
    // And EVERY branch here is confirmed by a colon, bar the spread. That is
    // what makes it safe to act at a position this cannot fully establish is a
    // key: `inKeyPosition` reads the raw prefix, and the prefix ends in a comma
    // inside a type argument list too — `size: make<A, B>(), name: 1` puts `B`
    // one character after a comma at depth 0, because angle brackets are not
    // depth (Codex review). Nothing there is followed by a colon, so nothing
    // here fires on it; a version of this that refused whatever it could not
    // classify turned that valid value into a failed surface check.
    if (depth === 0 && !/\s/.test(ch) && inKeyPosition(i)) {
      // A quoted key is a key: `'name': str(…)` names the field `name` exactly
      // as `name:` does. Stepping over the literal without looking for the colon
      // reads the object as having no field there at all — and an object read as
      // having no fields is a route documenting no body, which matches a mirror
      // that lists none. That match is the vacuous all-clear this whole gate is
      // built to refuse.
      if (ch === "'" || ch === '"' || ch === '`') {
        const end = quotedEnd(body, i);
        const colon = body.slice(end).match(/^\s*:/);
        if (colon) {
          const inner = body.slice(i + 1, end - 1);
          // A key spelled with a hole in it names nothing this can resolve, and
          // it is a field of the route either way. Refused, where it used to be
          // dropped: a guess at the name would be wrong, and silence is a field
          // nobody compared.
          if (ch === '`' && hasHole(inner)) {
            throw new Error(`an interpolated key this reader cannot resolve: ${seen(i)}`);
          }
          keys.push(unescaped(inner));
          i = end + colon[0].length;
          continue;
        }
        i = end;
        continue;
      }
      // A spread needs no colon to be unambiguous: three dots at the top level
      // of an object literal are a spread and nothing else. What it carries is
      // somewhere this reader cannot look, and reading it as no fields at all is
      // how a body passes for a route that documents none.
      if (body.startsWith('...', i)) {
        throw new Error(`a spread whose fields this reader cannot see: ${seen(i)}`);
      }
      // A computed key, once the `]` that closes it is followed by a colon. The
      // colon is the whole of the confirmation: `make<[A, B]>()` also puts a `[`
      // where a key could be, and it names no field.
      if (ch === '[') {
        const closed = i + balanced(body, i, '[', ']').length + 2;
        if (body.slice(closed).match(/^\s*:/)) {
          throw new Error(`a computed key this reader cannot resolve: ${seen(i)}`);
        }
      }
      // A number is as much a key as an identifier is — `123: str(…)` names the
      // field `123` — and it is confirmed the same way. A numeral one character
      // after a comma in a type argument list is not followed by a colon
      // (Codex review).
      //
      // Plain digits only, and every other numeric spelling is refused rather
      // than read: the property name is the number's VALUE, so `1_000`, `0x10`
      // and `123n` name the fields `1000`, `16` and `123`, and a reader handing
      // back the source text reports three fields nobody serves while the three
      // that are served go unmentioned. Resolving them here would be a numeric
      // parser this file has no other use for (Codex review).
      const numeric = body.slice(i).match(/^(\d[\w$.]*)\s*:/);
      if (numeric && !/^\d+$/.test(numeric[1])) {
        throw new Error(`a numeric key this reader cannot resolve: ${seen(i)}`);
      }
      const named = body.slice(i).match(/^((?:[A-Za-z_$][\w$]*|\d+))\s*:/);
      if (named) {
        keys.push(named[1]);
        i += named[0].length;
        continue;
      }
      // A getter declares a field too, and it has no colon to confirm it — but
      // `get` followed by a name followed by `(` is not a shape anything else
      // here produces, so the keyword does the confirming instead. Read rather
      // than refused, since the name is right there; `set` with it, because it
      // names a field of the same object by the same rule, and a name read from
      // both spellings of one field is one key twice — which is one key, to the
      // set the caller collects these into (Codex review).
      const accessor = body.slice(i).match(/^(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (accessor) {
        keys.push(accessor[1]);
        i += accessor[0].length - 1;
        continue;
      }
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      // Valid source cannot close what it never opened, and the depth never
      // climbs back: every key after the stray closer is dropped, and what the
      // caller reads is an object with no fields rather than one it could not
      // parse. `entries` throws on the same condition for the same reason.
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
      i = lineCommentEnd(body, i + 2);
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

/**
 * Each comma-separated element of one list or object body, at its own depth.
 *
 * A sibling of `entries` for the lists whose elements are not all object
 * literals: `query: [{ name: 'limit' }, ALLOW_PARTIAL]` holds one of each, and
 * a caller that has to tell them apart needs the elements before it can. The
 * commas inside a literal or a nested collection belong to their element, which
 * is what makes this a walk rather than a `split(',')`.
 *
 * A trailing comma is allowed, because a formatter writes them. A hole — `[a, ,
 * b]` — is not: it is either a sparse array this reader has no meaning for or a
 * delimiter it got wrong, and both are worth hearing about rather than being
 * handed one element fewer.
 */
export function listItems(body) {
  const items = [];
  const opener = { '}': '{', ']': '[', ')': '(' };
  const stack = [];
  let from = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(body, i);
      continue;
    }
    if (ch === '/' && body[i + 1] === '/') {
      i = lineCommentEnd(body, i + 2);
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      i = end === -1 ? body.length : end + 2;
      continue;
    }
    if (ch === '/' && regexCanStart(body, i)) {
      i = regexEnd(body, i);
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') stack.push(ch);
    else if (ch === '}' || ch === ']' || ch === ')') {
      // Valid source cannot close what it never opened. Recovering from one
      // would mean reading the rest of the body at a depth that is wrong for
      // good, and handing back however many elements survived that.
      if (stack.pop() !== opener[ch]) throw new Error(`unbalanced ${ch} at offset ${i}`);
    } else if (ch === ',' && stack.length === 0) {
      const item = body.slice(from, i).trim();
      if (item === '') throw new Error(`empty list element at offset ${i}`);
      items.push(item);
      from = i + 1;
    }
    i++;
  }
  if (stack.length) throw new Error('unbalanced list body');
  const tail = body.slice(from).trim();
  if (tail !== '') items.push(tail);
  return items;
}

/**
 * The fields of an object literal body, by name, or a throw for an entry this
 * cannot read.
 *
 * `topLevelKeys` answers what an object names and `topLevelField` answers one
 * quoted value; this is for the caller that has to account for EVERY entry —
 * the platform's `DOCS`, whose keys are the routes being compared. Read with a
 * regex, a route key spelled with double quotes is not matched, the entry is
 * skipped, and the route is compared against no parameters at all while the
 * scan's own "found nothing" guard stays quiet because the other entries
 * counted. A spread, or a key computed from an identifier, is refused for the
 * same reason: what it holds cannot be seen, and the caller must not be handed
 * a table that is short by however much it carried.
 */
export function objectFields(body) {
  const fields = new Map();
  for (const item of listItems(body)) {
    const quote = item[0];
    let key;
    let value;
    if (quote === "'" || quote === '"' || quote === '`') {
      const end = quotedClose(item, 0);
      if (end === -1) throw new Error(`unterminated key in ${JSON.stringify(item.slice(0, 40))}`);
      const inner = item.slice(1, end - 1);
      // A template key with a hole in it names nothing that can be resolved
      // here, and a guess at one is worse than saying so.
      if (quote === '`' && hasHole(inner)) {
        throw new Error(`interpolated key in ${JSON.stringify(item.slice(0, 40))}`);
      }
      const rest = item.slice(end).trimStart();
      if (!rest.startsWith(':')) {
        throw new Error(`expected a colon after the key in ${JSON.stringify(item.slice(0, 40))}`);
      }
      key = unescaped(inner);
      value = rest.slice(1).trim();
    } else {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(item);
      if (!m) throw new Error(`unsupported object entry ${JSON.stringify(item.slice(0, 40))}`);
      key = m[1];
      value = item.slice(m[0].length).trim();
    }
    if (value === '') throw new Error(`no value for the key ${JSON.stringify(key)}`);
    // Two spellings of one key is one of them winning, and which one depends on
    // the order they are read in. That is a coin toss over a route's parameters.
    if (fields.has(key)) throw new Error(`duplicate key ${JSON.stringify(key)}`);
    fields.set(key, value);
  }
  return fields;
}

/**
 * Each match of `pattern` that is in module code, rather than inside a literal
 * or a nested scope.
 *
 * `indexOf('export const V1_ROUTES: Route[] = [')` finds the first spelling of
 * that text anywhere in the file, and anywhere includes inside a regex literal:
 * `export default /a; export const V1_ROUTES … ; z/;` is legal TypeScript, and
 * the table in it was read as the real one. The scope half matters for the same
 * reason — a declaration of the same name inside a function is not the module's
 * table, and reading it instead compares the mirror against something nothing
 * serves.
 *
 * `source` must be comment-blanked, which is also the cheap half of the answer:
 * a declaration quoted in a comment — which is how apidoc.ts explains itself —
 * is already spaces by the time this runs.
 *
 * The pattern is expected to end at the initializer's opening delimiter, and
 * that delimiter is then walked over like any other, so what is inside the
 * declaration counts as nested and a second declaration cannot be found there.
 */
export function moduleDeclarations(source, pattern) {
  const found = [];
  const opener = { '}': '{', ']': '[', ')': '(' };
  const stack = [];
  const at = new RegExp(pattern, 'y');
  let i = 0;
  while (i < source.length) {
    let ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = lineCommentEnd(source, i + 2);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '/' && regexCanStart(source, i)) {
      i = regexEnd(source, i);
      continue;
    }
    // Not mid-identifier: a `myexport const` is not an export, and a sticky
    // match started inside a longer word would read it as one.
    if (stack.length === 0 && !/[\w$]/.test(source[i - 1] ?? '')) {
      at.lastIndex = i;
      const m = at.exec(source);
      if (m) {
        found.push({ index: i, length: m[0].length, groups: m.slice(1) });
        i = at.lastIndex - 1;
        ch = source[i];
      }
    }
    if (ch === '{' || ch === '[' || ch === '(') stack.push(ch);
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (stack.pop() !== opener[ch]) throw new Error(`unbalanced ${ch} at offset ${i}`);
    }
    i++;
  }
  if (stack.length) throw new Error('unbalanced module scope');
  return found;
}

/**
 * The value of `text` when it is exactly one plain quoted literal, else
 * `undefined`.
 *
 * Any of the three quote styles, which is the point of it. The mirror tables
 * were read with `/'([^']+)'/g`, so an entry a formatter or an author wrote with
 * double quotes matched nothing and was skipped — and a skipped entry is not a
 * complaint, it is a table that is short by however much it held. The caller
 * decides what to do about an unreadable element; this only answers whether the
 * element IS a plain string.
 *
 * Escapes are RESOLVED rather than refused, through the same `unescaped` the rest
 * of this file reads literals with: `"a\x2Fb"` is the four characters `a/b` and a
 * reader that answered `a\x2Fb` would compare a route nobody serves. A template
 * that interpolates is the one thing refused, because what it spells depends on
 * values this reader cannot see.
 */
export function stringLiteral(text) {
  const t = text.trim();
  const quote = t[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  // The literal has to be the WHOLE of the element. `'a' + b` and `'a'.repeat(2)`
  // both start with a readable literal and mean something else.
  if (quotedEnd(t, 0) !== t.length) return undefined;
  const inner = t.slice(1, -1);
  if (quote === '`' && hasHole(inner)) return undefined;
  return unescaped(inner);
}

/**
 * The body of the array literal a table's initializer IS, and a throw for an
 * initializer that is anything more than one.
 *
 * The tables read here are arrays, but not always the initializer itself: one is
 * `new Set((<array> as Route[]).map(...))` and another is `new Map(<array>)`.
 * Finding the array with `indexOf('[')` reads the `[` of the `as Route[]`
 * annotation, and a regex over the declaration reads whichever bracket comes
 * first — including one inside a nested literal, and including the `[m, p]` of
 * the `.map` destructuring that follows the real table.
 *
 * Taking the LEADING array is not enough either, which is the adversarial review
 * finding this answers: `(<array>.concat([['GET', 'gone']]) as Route[]).map(...)`
 * type-checks, puts a route in the Set, and leaves the leading array — the one a
 * leading-array reader compares — without it. The extra route is then a route the
 * mirror lists and the comparison never sees, which is the false all-clear this
 * whole file exists to refuse.
 *
 * So the initializer must REDUCE to the array, and every piece of it is
 * whitelisted:
 *
 * - wrapping parentheses, however many;
 * - a trailing `as <type>`, the annotation being the point of the parentheses;
 * - one trailing `.map(...)`, which cannot change how many elements there are —
 *   that is what makes it safe to look through, and `concat`, `filter`, `flatMap`
 *   and a spread are all refused because they can.
 *
 * Anything else is a table this reader would compare part of. It throws instead,
 * naming what it could not reduce.
 */
/** The one destructured parameter the permitted projection takes. */
const DESTRUCTURED_PAIR =
  /^\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*\](?:\s*:\s*[^=]*)?$/;

/**
 * Whether `text` is the one projection this reader can account for: the
 * destructured pair joined by a space.
 *
 * Parsed rather than matched with one regex, which is what the third round of this
 * finding cost. `(?::[^)]*)?` for the parameter's type annotation also swallowed
 * ADDITIONAL parameters, and `.map` passes only three arguments — so a fourth
 * parameter with a default ran that default:
 * `([m, p]: Route, _i, _a, unused = p = 'gone') => ${'`${m} ${p}`'}` type-checks, returns
 * `GET gone` at runtime, and matched. So the parameter list is split with
 * `listItems` and there has to be exactly ONE of them, carrying no `=`.
 *
 * The call's arguments are split the same way, for the false refusal alongside it:
 * a formatter wrapping the call leaves a trailing comma after the callback, and a
 * regex anchored at the template's backtick refused a legal projection — a gate
 * that a reformat takes down is a broken gate.
 */
/**
 * Whether a parameter list holds exactly one parameter.
 *
 * `listItems` cannot answer this, and that is the whole reason this exists: it
 * balances `()`, `[]` and `{}` and knows nothing about `<>`, so a legal
 * `([m, p]: Route<string, string>)` reads as two parameters. Matching the whole
 * list against one pattern instead — with the annotation as `[^=]*` — was the
 * other direction of the same mistake, and it admitted a PROVEN false all-clear:
 * an extra destructured parameter whose computed key runs without containing an
 * `=` changed the value the callback returned while the reader went on reporting
 * the routes of the array it could see.
 *
 * So the commas are counted with the angle brackets balanced too. A `>` whose
 * previous character is `=` is an arrow's and closes nothing, and `<`/`>` count
 * only at bracket depth zero — inside `()`, `[]` or `{}` a `<` may be a
 * comparison, and a wrong angle depth there would be a wrong answer rather than a
 * refusal.
 */
function oneParameter(paramsText) {
  let brackets = 0;
  let angles = 0;
  let i = 0;
  /** Whether only whitespace and comments are left, which makes a comma terminal. */
  const nothingAfter = (from) => {
    let j = from;
    while (j < paramsText.length) {
      if (/\s/.test(paramsText[j])) {
        j++;
        continue;
      }
      if (paramsText[j] === '/' && paramsText[j + 1] === '/') {
        j = lineCommentEnd(paramsText, j + 2);
        continue;
      }
      if (paramsText[j] === '/' && paramsText[j + 1] === '*') {
        const end = paramsText.indexOf('*/', j + 2);
        if (end === -1) return false;
        j = end + 2;
        continue;
      }
      return false;
    }
    return true;
  };
  while (i < paramsText.length) {
    const ch = paramsText[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(paramsText, i);
      continue;
    }
    // Comments are stepped over BEFORE anything is counted, because a bracket
    // inside one is not a bracket: `([m, p]: Route /* < */, _i, { [++(p as any)]: u })`
    // left the angle depth positive for the rest of the list, hid the commas after
    // it, and read as one parameter — the same false all-clear in a new spelling
    // (second review round of OPL-4830).
    if (ch === '/' && paramsText[i + 1] === '/') {
      i = lineCommentEnd(paramsText, i + 2);
      continue;
    }
    if (ch === '/' && paramsText[i + 1] === '*') {
      const end = paramsText.indexOf('*/', i + 2);
      // An unterminated comment is not something to read past.
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') brackets++;
    else if (ch === ')' || ch === ']' || ch === '}') brackets--;
    else if (ch === '<' && brackets === 0) angles++;
    else if (ch === '>' && brackets === 0 && paramsText[i - 1] !== '=' && angles > 0) angles--;
    else if (ch === ',' && brackets === 0 && angles === 0) {
      // A TERMINAL comma is punctuation, not a parameter: `([m, p]: Route,) => …`
      // is one parameter and a formatter writes it that way on a wrapped line.
      // Refusing it made a supported projection fail over a comma (second review
      // round).
      if (!nothingAfter(i + 1)) return false;
      break;
    }
    i++;
  }
  // A depth that does not come back to zero means this reader lost track of the
  // list rather than read it, and the answer it would give is a guess.
  return brackets === 0 && angles === 0;
}

function joinsThePair(argsText) {
  const args = listItems(argsText);
  if (args.length !== 1) return false;
  const arrow = args[0].trim();
  if (!arrow.startsWith('(')) return false;
  const params = balanced(arrow, 0, '(', ')');
  const body = arrow.slice(params.length + 2).trim();
  // The arrow and its body trimmed apart, because a formatter puts the template on
  // its own line when the parameter's annotation is long, and comparing the whole
  // tail to one string refused exactly that.
  if (!body.startsWith('=>')) return false;
  // The whole parameter text against one pattern rather than split into
  // parameters first: `listItems` does not balance angle brackets, so a legal
  // `([m, p]: Route<string, string>)` read as TWO parameters and a mirror a
  // formatter would produce was refused. What actually has to be excluded is a
  // DEFAULT — the only thing an extra parameter can do to a value, since `.map`
  // passes three arguments and a default runs — and every default contains an
  // `=`, which the annotation here may not. An extra parameter without one cannot
  // change what the callback returns.
  // Exactly one parameter, counted with the angle brackets balanced, BEFORE the
  // shape is matched. `DESTRUCTURED_PAIR`'s annotation tail is `[^=]*`, which
  // swallows further parameters whole, and a default is not the only thing an
  // extra parameter can do to the value: `([m, p]: Route, _i, { [++(p as any)]: u })`
  // type-checks, holds no `=` at all, and returns `GET NaN` from a reader that
  // reported `GET sizes` (review of OPL-4830).
  if (!oneParameter(params)) return false;
  const named = DESTRUCTURED_PAIR.exec(params.trim());
  if (!named) return false;
  return body.slice(2).trim() === `\`\${${named[1]}} \${${named[2]}}\``;
}

export function tableArrayLiteral(text, what = 'this declaration', projections = null) {
  const refuse = (why, at) => {
    throw new Error(`${what} ${why}: ${JSON.stringify(at.trim().slice(0, 60))}`);
  };
  let t = text.trim();
  let maps = 0;
  // Ten is past any nesting a formatter produces and stops a rule that fails
  // to shorten `t` from spinning. Each pass below strips at least one construct.
  for (let pass = 0; pass < 10; pass++) {
    // The trailing comma a formatter leaves on a multi-line argument. Stripped
    // first, because every rule below reads the last character.
    if (t.endsWith(',')) {
      t = t.slice(0, -1).trimEnd();
      continue;
    }
    // One trailing `.map(...)`, stripped before the parentheses around it: the
    // call's own `(` would otherwise read as a wrapper that never closes here.
    //
    // And the CALLBACK is checked, not waved through, which is the second round
    // of the same finding. `.map` preserving the element count is not enough:
    // `([['GET', 'sizes']] as Route[]).map(() => 'GET gone')` type-checks and puts
    // a route in the Set that is in no array this reader can see. The one
    // projection it knows how to account for is the pair joined by a space, so
    // that is the one it accepts — spelled any way, with any two parameter names,
    // and anything else refused. Pinning the shape means a rewrite of the callback
    // breaks this gate LOUDLY, which is the correct direction for a gate to fail.
    const map = trailingCall(t, '.map');
    if (map !== undefined) {
      if (maps++ > 0) refuse('chains more than one .map, which this reader cannot follow', t);
      if (!joinsThePair(map.argument)) {
        refuse('maps its entries with a callback this reader cannot account for', map.argument);
      }
      t = map.receiver.trim();
      continue;
    }
    if (t.startsWith('(')) {
      const inner = balanced(t, 0, '(', ')');
      // Only when the `)` is the END of it. `(a) + (b)` opens with a parenthesis
      // and is not a parenthesised expression.
      if (`(${inner})` === t) {
        t = inner.trim();
        continue;
      }
    }
    // `as <type>` — an identifier, dots and `[]`, and NO type arguments at all.
    //
    // Three rounds of narrowing a pattern here each admitted the next spelling, and
    // the third is the one that settles it. `as any<X, Y>[]` is not a type:
    // TypeScript ends the type at `any` and reads `< X, Y > []` as comparisons and a
    // comma expression, so the value reaching the call is a boolean while the reader
    // erased the suffix and certified the array it could see. Restricting the
    // arguments to keyword types looked sufficient — `string` is not a value — until
    // `const string: any = 1` made it one, and `as any<string, string>[]` type-checks
    // and returns `true` at runtime (review of OPL-4830). Nothing about the SHAPE of
    // a generic suffix can tell the two apart, because which reading TypeScript
    // takes depends on what names are in scope, which this reader cannot see.
    //
    // So no generic suffix is read through. The body reader in this same file
    // refuses every `as` suffix for exactly this reason and pays a refusal for it;
    // this is the same answer, kept as narrow as the tables need — `as Route[]` is
    // how every mirror spells its own, and a generic one is refused by name rather
    // than guessed at.
    const as = /\sas\s+[A-Za-z_$][\w$.]*(?:\s*\[\s*\])*\s*$/.exec(t);
    if (as) {
      t = t.slice(0, as.index).trim();
      continue;
    }
    break;
  }
  // The projection is REQUIRED where the table has one, not merely permitted at
  // most once. `new Set([['GET', 'sizes']] as unknown as Iterable<string>)` reduces
  // to the array this reader compares and builds a Set of ARRAYS at runtime, so
  // every `has()` on it is false — a mirror that matches and asserts nothing. The
  // caller says how many projections its table is built with, and zero is as wrong
  // as two when the answer is one.
  if (projections !== null && maps !== projections) {
    refuse(`is built with ${maps} projections where this reader expects ${projections}`, text);
  }
  if (!t.startsWith('[')) refuse('is not an array literal this reader can read', t);
  const body = balanced(t, 0, '[', ']');
  // The array has to BE the whole of what is left, not the front of it: the
  // `.concat` above ends in a `)` and a `[0]` index ends in a `]`, and both would
  // otherwise pass as "starts with an array".
  if (`[${body}]` !== t) refuse('holds more than one array literal expression', t);
  return body;
}

/**
 * The argument text of a trailing `<name>(...)` call, or `undefined`.
 *
 * Both halves come back: `X.map(f)` answers `{ receiver: 'X', argument: 'f' }`.
 * Literal-aware, so a `.map(` inside a string is not one, and the call's closing
 * parenthesis has to be the last character — a call in the middle of an expression
 * is not something to look through.
 */
function trailingCall(text, name) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = lineCommentEnd(text, i + 2);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '/' && regexCanStart(text, i)) {
      i = regexEnd(text, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      const close = { '(': ')', '[': ']', '{': '}' }[ch];
      const inner = balanced(text, i, ch, close);
      const after = i + inner.length + 2;
      const opensCall = text.slice(0, i).trimEnd().endsWith(name);
      if (ch === '(' && opensCall && after === text.length) {
        return {
          receiver: text.slice(0, text.slice(0, i).trimEnd().length - name.length),
          argument: inner,
        };
      }
      i = after;
      continue;
    }
    i++;
  }
  return undefined;
}

/**
 * The offset just past the `=` of a module-level declaration starting at `from`.
 *
 * Written because a regex could not do it. `export const NAME\s*:[^=]*=\s*new
 * Map\(` looks like it reads a declaration and its initializer, and
 * `moduleDeclarations` only guarantees where the match STARTS — so `[^=]*` is
 * free to run through a quote and find its `new Map(` inside a STRING in the type
 * annotation. An annotation carrying `& { decoy?: "= new Map([['GET x', []]])" }`
 * type-checks, and the reader compared the mirror against the decoy's table.
 *
 * The same regex refuses a legal annotation for the mirror image of the reason:
 * `{ optional?: () => string }` holds an `=`, so `[^=]*` stops at it and the
 * `new Map(` never matches. A depth-aware walk answers both — that `=` is inside
 * braces, and this only stops at depth zero.
 *
 * `=>`, `==`, `!=`, `<=` and `>=` are not assignments and are stepped over.
 *
 * So is an `=` inside a generic's own brackets, which is a type parameter's
 * DEFAULT and not this declaration's initializer. `Box<<U = string>() => U>` is a
 * legal annotation, and stopping at its `U =` reported the table as declared
 * without an initializer — a false refusal of valid source (review of OPL-4830).
 * The angle depth is tracked only at bracket depth zero, where a `<` in a type
 * annotation can only be a generic's: inside `()`, `[]` or `{}` the depth rule
 * above already steps over every `=`, and guessing at a `<` there would risk
 * stepping over the real assignment instead.
 */
export function declarationAssignment(source, from) {
  let depth = 0;
  let angles = 0;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = lineCommentEnd(source, i + 2);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '/' && regexCanStart(source, i)) {
      i = regexEnd(source, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      // A closer at depth zero ends the declaration without an initializer, and
      // reading on would find the NEXT one's.
      if (depth-- === 0) return -1;
    } else if (ch === '<' && depth === 0) angles++;
    else if (ch === '>' && depth === 0 && source[i - 1] !== '=' && angles > 0) angles--;
    else if (ch === ';' && depth === 0) return -1;
    else if (ch === '=' && depth === 0 && angles === 0) {
      const next = source[i + 1];
      const prev = source[i - 1];
      // `=>`, `==`, `===` and `!=` only. A `<` or `>` in FRONT is not a comparison
      // here: in a type annotation it is a generic's bracket, and
      // `ReadonlyMap<string, readonly string[]>=new Map(...)` — unformatted, but
      // legal — was read as `>=`, so the real assignment was skipped and the table
      // reported undeclared.
      if (next === '=' || next === '>' || prev === '=' || prev === '!') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}
