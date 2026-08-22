/** The end of one quoted literal, or -1 when the literal is never closed. */
function quotedClose(text, from) {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return -1;
}

/** Advance past one single-, double-, or backtick-quoted literal. */
function quotedEnd(text, from) {
  const end = quotedClose(text, from);
  return end === -1 ? text.length : end;
}

/** Whether a slash here can begin a regex literal rather than divide values. */
function regexCanStart(text, from) {
  let i = from - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  if ('([{=,:;!?&|~+*%^<>'.includes(text[i])) return true;
  const word = text.slice(0, i + 1).match(/([A-Za-z_$][\w$]*)$/)?.[1];
  return word === 'return' || word === 'case' || word === 'throw' || word === 'yield';
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
      out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === 'u' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      out += String.fromCodePoint(Number.parseInt(text.slice(i + 2, end), 16));
      i = end;
    } else if (next === 'u') {
      out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
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
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === "'" || ch === '"' || ch === '`') {
      i = quotedEnd(body, i);
      continue;
    } else if (ch === '/' && regexCanStart(body, i)) {
      i = regexEnd(body, i);
      continue;
    }
    if (depth === 0) {
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
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === "'" || ch === '"' || ch === '`') {
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
 */
export function entries(body) {
  const out = [];
  let depth = 0;
  let from = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
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
    }
    i++;
  }
  if (depth !== 0) throw new Error('unbalanced { in list body');
  return out;
}
