// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from the behaviour described in the generator's README: same inputs,
// same output tree byte for byte, but structured for speed instead of for
// plugin-by-plugin clarity. No dependencies, no I/O, no randomness, no clock.
//
// Where the time goes in the reference: re-lexing Markdown into throwaway
// token objects, re-rendering templates by walking a node tree with a fresh
// scope object per loop element, re-slugifying the same titles/tags/headings,
// and escaping text one character at a time. This version:
//
//  * renders Markdown in one fused pass over the lines (no token array),
//    with an inline renderer that accumulates plain runs and escapes them
//    in bulk, and only recurses for nested strong/em/link spans;
//  * compiles each template once per case into a plain JS function
//    (via the Function constructor) so rendering a page is straight-line
//    code: no node dispatch, no per-element scope allocation (one mutable
//    vars/loop pair per `for`, pushed once), includes as direct calls;
//  * memoises slugify (ASCII fast path: NFKD is the identity on ASCII and
//    ASCII has no combining marks, so the normalise/strip step is skipped),
//    and computes each tag slug / card / reading time exactly once;
//  * parses front matter by scanning lines without splitting the body,
//    and resolves links with cheap prefix checks before the general path
//    resolver.
//
// Every rule (front-matter refusals and their order, slug uniqueness,
// collection/tag ordering, template parse errors, standalone-tag line
// eating, broken-link reporting, report sorting) follows the reference.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
export function escapeHtml(text) {
  // One scan; with no match replace returns the input itself.
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  if (slugCache.size < 50000) slugCache.set(text, out);
  return out;
}
function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) out = `${slug}-${++n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Count runs of non-whitespace (what /\S+/g counts) without allocating
// the match array. ASCII whitespace is 9, 10, 11, 12, 13, 32; other
// control codes are not whitespace; non-ASCII is checked against the
// remaining JavaScript whitespace code points.
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
        (c > 127 && (c === 133 || c === 160 || c === 576 || (c >= 8192 && c <= 8202) ||
          c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279))) {
      inWord = false;
    } else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  // The body is never split: only the front-matter lines are.
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1; // index of the '\n' ending the closing line, or text.length
  let pos = firstNl === -1 ? text.length : firstNl;
  while (pos < text.length) {
    // pos is at a '\n' (or the start); the next line starts at pos + 1,
    // except pos === -1 handled above. Find a line that is exactly '---'.
    const lineStart = pos + 1;
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    if (end - lineStart === 3 && text[lineStart] === '-' && text[lineStart + 1] === '-' && text[lineStart + 2] === '-') {
      closeStart = lineStart;
      closeEnd = end;
      break;
    }
    if (lineEnd === -1) break;
    pos = lineEnd;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmStart = firstNl + 1;
  if (closeStart > fmStart) {
    const fmLines = text.slice(fmStart, closeStart - 1).split('\n');
    for (let idx = 0; idx < fmLines.length; idx++) {
      const line = fmLines[idx];
      if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue; // blank or '#'
      const m = LINE.exec(line);
      if (!m) return { error: `line ${idx + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS_RE = /\s/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  return (c === 32 || c === 9) && BLANK.test(line);
}

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null; // '#'
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}
function isFence(line) {
  return line.charCodeAt(0) === 96 && FENCE_OPEN.test(line); // '`'
}
function isHr(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR.test(line); // '-' or '*'
}
function endsParagraph(line) {
  return isBlank(line) || isFence(line) || headingOf(line) !== null || isHr(line);
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering. Plain runs between markup characters are sliced and
// escaped in bulk; only the constructs that change structure are handled
// one at a time.
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Next markup character: \ ` * [
    let j = n;
    let k = s.indexOf('\\', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i); if (k !== -1 && k < j) j = k;
    if (j > i) out += escapeHtml(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else { out += '\\'; i++; }
      continue;
    }
    if (c === '`') {
      const m = s.indexOf('`', i + 1);
      if (m > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, m))}</code>`;
        i = m + 1;
      } else { out += '`'; i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const m = findUnescaped(s, '**', i + 2);
        if (m > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, m), env)}</strong>`;
          i = m + 2;
        } else { out += '**'; i += 2; }
        continue;
      }
      const m = findSingleStar(s, i + 1);
      if (m > i + 1) {
        out += `<em>${inline(s.slice(i + 1, m), env)}</em>`;
        i = m + 1;
      } else { out += '*'; i++; }
      continue;
    }
    // c === '['
    const k2 = findUnescaped(s, ']', i + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k2), env)}</a>`;
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

// One fused block pass: no token objects, blocks are rendered straight
// into the output array.
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const f0 = line.charCodeAt(0);
    if (f0 === 96) { // '`': possible fence
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        let code = '';
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) code += escapeHtml(lines[i++]) + '\n';
        i++;
        blocks.push(`<pre><code${fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`}>${code}</code></pre>`);
        continue;
      }
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (f0 === 62) { // '>': blockquote
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const ls = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') ls.push(t); }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (f0 === 45 || f0 === 42) ? BULLET.exec(line) : null; // '-' or '*'
    const ordered = bullet === null && f0 >= 48 && f0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) { items.push([trimLine(isOrdered ? m[2] : m[1])]); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${isOrdered ? 'ol' : 'ul'}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${isOrdered ? 'ol' : 'ul'}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Scope lookup: first segment from the nearest scope holding it, then own
// properties only. S is an array of vars objects, innermost last.
function lookup(S, path) {
  for (let i = S.length - 1; i >= 0; i--) {
    const scope = S[i];
    if (!hasOwn(scope, path[0])) continue;
    let v = scope[path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) { if (i) out += ', '; out += textOf(v[i]); }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Compile parsed nodes to a render function (S, D, T) -> string. A `for`
// reuses one vars object and one loop object across its iterations instead
// of allocating a scope per element.
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  let uid = 0;
  const gen = (list) => {
    let s = '';
    for (const n of list) {
      if (n.kind === 'text') s += `o+=${JSON.stringify(n.text)};`;
      else if (n.kind === 'var') s += `o+=esc(txt(lk(S,${JSON.stringify(n.path)})));`;
      else if (n.kind === 'raw') s += `o+=txt(lk(S,${JSON.stringify(n.path)}));`;
      else if (n.kind === 'if') {
        s += `if(tr(lk(S,${JSON.stringify(n.path)}))!==${n.not}){${gen(n.then)}}`;
        if (n.else !== null) s += `else{${gen(n.else)}}`;
      } else if (n.kind === 'for') {
        const u = ++uid;
        const key = JSON.stringify(n.name);
        s += `{const _a${u}=lk(S,${JSON.stringify(n.path)});if(Array.isArray(_a${u})){const _v${u}={};const _l${u}={index:0,first:false,last:false,length:_a${u}.length};_v${u}[${key}]=null;_v${u}.loop=_l${u};S.push(_v${u});for(let _i${u}=0;_i${u}<_a${u}.length;_i${u}++){_v${u}[${key}]=_a${u}[_i${u}];_l${u}.index=_i${u}+1;_l${u}.first=_i${u}===0;_l${u}.last=_i${u}===_a${u}.length-1;${gen(n.body)}}S.pop();}}`;
      } else if (n.kind === 'include') {
        s += `{if(D<8){const _t=T.get(${JSON.stringify(n.name)});if(_t!==undefined)o+=_t(S,D+1,T);}}`;
      }
    }
    return s;
  };
  const factory = new Function('esc', 'txt', 'tr', 'lk', `return function(S,D,T){let o='';${gen(nodes)}return o;}`);
  return factory(escapeHtml, textOf, truthy, lookup);
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources, sorted by path; .md sources have \r\n / \r made \n.
  const sorted = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Front matter, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (!s.post) {
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
    }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    s.newer = null;
    s.older = null;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages / static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const link = (target) => {
      if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${spath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: newest date first, ties by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, ordered by count then slug. Each tag slug
  //    is computed once per distinct name.
  const bySlug = new Map();
  const ownTagList = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTagList(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagList(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards: one per source, built once and reused by pages, index, tags.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  // 7. Layouts.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn([{ site, tags: allTags, recent, ...vars }], 0, templates);
  };
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        ...s.card,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer),
        older: linkOf(s.older),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
