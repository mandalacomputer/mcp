/** Advance past one single-, double-, or backtick-quoted literal. */
function quotedEnd(text, from) {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
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
