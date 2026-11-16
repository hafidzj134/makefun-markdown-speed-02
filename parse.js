// parse.js — a fast, dependency-free Markdown-to-HTML renderer.
//
// parse(markdown) returns the HTML for a Markdown document, following the
// CommonMark 0.31.2 + GFM behaviour profile this project targets: ATX and
// setext headings, fenced and indented code, block quotes, lists (with task
// items), thematic breaks, link reference definitions, GFM tables, raw HTML
// blocks, and the full inline grammar (code spans, links, images, emphasis,
// strikethrough, autolinks, hard breaks, entities and raw HTML).
//
// The implementation is a hand-written two-phase compiler: a line-oriented
// block lexer builds a small token tree while collecting link reference
// definitions, then a renderer walks the tree and runs a scanner-based
// inline parser for text runs. No dependencies, no I/O, deterministic.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPABLE = '\\!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~';

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
// Punctuation for flanking tests: the full Unicode P and S categories.
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
           (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return UNICODE_PUNCT.test(ch);
}

// Only ASCII punctuation can be backslash-escaped.
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
         (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
         ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u1680' ||
         (ch >= '\u2000' && ch <= '\u200a') || ch === '\u202f' ||
         ch === '\u205f' || ch === '\u3000' || ch === '\ufeff';
}

// Escape text-node content: &, <, > — but leave well-formed entity
// references alone (numeric references are decoded to their character).
const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/g;

// The character a numeric character reference stands for, with the
// usual replacement-character rules.
function entityChar(body) {
  let cp;
  if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
  else cp = parseInt(body.slice(1), 10);
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return String.fromCodePoint(cp);
}

// Escape a single character for text content.
function escapeChar(ch) {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return ch;
  }
}

function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (ch === '>') { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (ch === '"') { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (ch === "'") { out += s.slice(last, i) + '&#39;'; last = i + 1; }
    else if (ch === '&') {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(s);
      if (m && m.index === i) {
        const body = m[1];
        if (body[0] === '#') {
          out += s.slice(last, i) + escapeChar(entityChar(body));
          i += m[0].length - 1;
          last = i + 1;
        } else {
          // Named reference: keep the source spelling untouched.
          out += s.slice(last, i) + m[0];
          i += m[0].length - 1;
          last = i + 1;
        }
      } else {
        out += s.slice(last, i) + '&amp;';
        last = i + 1;
      }
    }
  }
  return out + s.slice(last);
}

// Escape code content (&, <, > and double quotes).
function escapeCode(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape an attribute value (double-quoted context): like text escaping,
// existing entity references are preserved.
function escapeAttr(s) {
  if (!/[&<>"]/.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') { out += s.slice(last, i) + '&lt;'; last = i + 1; }
    else if (ch === '>') { out += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (ch === '"') { out += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (ch === '&') {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(s);
      if (m && m.index === i) {
        out += s.slice(last, i) + m[0];
        i += m[0].length - 1;
        last = i + 1;
      } else {
        out += s.slice(last, i) + '&amp;';
        last = i + 1;
      }
    }
  }
  return out + s.slice(last);
}

// Percent-encode a link destination the way the reference renderer does:
// a full encodeURI pass whose %25 sequences are folded back, so existing
// escapes survive while spaces, quotes, backslashes and non-ASCII bytes
// are encoded.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Unescape backslash escapes and decode entities in link destinations/titles.
function unescapeString(s) {
  if (!/[\\&]/.test(s)) return s;
  s = s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  s = s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g, (all, body) => entityChar(body));
  // Named entities in URLs: a small, common table; anything else stays as-is
  // except &amp; which decodes to &.
  s = s.replace(/&amp;/g, '&');
  return s;
}

// Normalise a link label for definition lookup: collapse internal
// whitespace runs to one space, trim, fold case (unicode-aware enough for
// the inputs we must handle: use toLowerCase plus ß/ς style folds below).
function normaliseLabel(s) {
  return s.replace(/[ \t\n\r]+/g, ' ').trim().toLowerCase()
          .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// ---------------------------------------------------------------------------
// Line utilities. Lines are handled as { text, end } slices of the source so
// tab handling can be done with explicit column arithmetic.
// ---------------------------------------------------------------------------

// Count leading indentation columns of a line starting at `pos`, treating a
// tab as advancing to the next multiple of 4. Returns { cols, pos } where
// pos is the index just past the consumed indent; a tab that would overshoot
// `maxCols` is only partially consumed (reported via `partial` = remaining
// columns of that tab kept as spaces count).
function measureIndent(line, pos, maxCols, baseCol) {
  baseCol = baseCol || 0;
  let cols = 0;
  let i = pos;
  while (i < line.length && cols < maxCols) {
    const ch = line[i];
    if (ch === ' ') { cols++; i++; }
    else if (ch === '\t') {
      const add = 4 - ((baseCol + cols) % 4);
      if (cols + add <= maxCols) { cols += add; i++; }
      else {
        // Partially consumed tab: caller treats (cols+add-maxCols) spaces
        // as remaining content prefix.
        return { cols: maxCols, pos: i, partial: cols + add - maxCols };
      }
    } else break;
  }
  return { cols, pos: i, partial: 0 };
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// ---------------------------------------------------------------------------
// Block-level grammar
// ---------------------------------------------------------------------------

const RE_BLANK = /^[ \t]*$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_QUOTE = /^ {0,3}>[ \t]?/;

// Strip a block quote marker from a line, column-aware: up to 3 leading
// spaces, the '>', and one optional space; a tab in the marker zone keeps
// its remaining column width as spaces. Returns null when the line does
// not start a quote.
function stripQuoteMarker(line, baseCol) {
  baseCol = baseCol || 0;
  let i = 0;
  let cols = 0;
  while (i < line.length && cols < 3 && line[i] === ' ') { i++; cols++; }
  if (line[i] !== '>') return null;
  i++; cols++;
  let partial = '';
  if (line[i] === '\t') {
    // The tab itself is the marker's one optional whitespace: only its
    // first column is consumed, the rest stays as content spaces.
    const w = 4 - ((baseCol + cols) % 4);
    partial = ' '.repeat(w - 1);
    cols += w;
    i++;
  } else if (line[i] === ' ') { i++; cols++; }
  // Materialise the rest of the content's leading whitespace run as
  // spaces, so any tab keeps the width it had at its original column.
  let text = partial;
  let c = cols;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { text += ' '; c++; i++; }
    else {
      const add = 4 - ((baseCol + c) % 4);
      text += ' '.repeat(add);
      c += add;
      i++;
    }
  }
  return { text: text + line.slice(i), cols };
}
const RE_DEF_START = /^ {0,3}\[/;

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Try to parse a link reference definition starting at lines[i].
// Returns { lines: n, label, href, title } or null. The label, the
// destination and the title may each start on a following line, and a
// title may span several lines; but junk after a same-line title (or
// other trailing text on the destination line) invalidates the whole
// definition, while a failed title on a FOLLOWING line simply leaves a
// title-less definition that ends at the destination line.
function tryParseDef(lines, i) {
  const first = lines[i];
  const m = /^ {0,3}\[/.exec(first);
  if (!m) return null;
  let li = i;
  let col = m[0].length;
  // Label: up to the first unescaped ], may span lines.
  let label = '';
  let closed = false;
  while (li < lines.length && li - i <= 20) {
    const line = lines[li];
    let j = col;
    let broke = false;
    while (j < line.length) {
      const ch = line[j];
      if (ch === '\\') { label += ch + (line[j + 1] ?? ''); j += 2; continue; }
      if (ch === '[') return null;
      if (ch === ']') { closed = true; col = j + 1; broke = true; break; }
      label += ch;
      j++;
    }
    if (broke) break;
    label += '\n';
    li++;
    col = 0;
    if (li < lines.length && RE_BLANK.test(lines[li])) return null;
  }
  if (!closed || label.length > 999) return null;
  if (normaliseLabel(label) === '') return null;
  if (lines[li][col] !== ':') return null;
  col++;
  // Destination: skip whitespace, crossing at most to the next line(s).
  const skipWs = () => {
    while (true) {
      const line = lines[li];
      while (col < line.length && (line[col] === ' ' || line[col] === '\t')) col++;
      if (col < line.length) return true;
      if (li + 1 >= lines.length || RE_BLANK.test(lines[li + 1])) return false;
      li++;
      col = 0;
    }
  };
  if (!skipWs()) return null;
  let href;
  {
    const line = lines[li];
    if (line[col] === '<') {
      const close = line.indexOf('>', col + 1);
      if (close === -1) return null;
      const inner = line.slice(col + 1, close);
      if (inner.includes('<')) return null;
      href = inner;
      col = close + 1;
    } else {
      let depth = 0;
      let j = col;
      while (j < line.length) {
        const ch = line[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === ' ' || ch === '\t') break;
        if (ch === '(') depth++;
        if (ch === ')') { depth--; if (depth < 0) return null; }
        j++;
      }
      if (depth !== 0) return null;
      href = line.slice(col, j);
      if (href.length === 0) return null;
      col = j;
    }
  }
  const destLine = li;
  // Scan a title starting at (tli, tcol) where lines[tli][tcol] is a quote.
  // Returns { title, endLine, endCol } or null.
  const scanTitle = (tli, tcol) => {
    const q = lines[tli][tcol];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const closer = q === '(' ? ')' : q;
    let t = '';
    let cli = tli;
    let ccol = tcol + 1;
    while (cli < lines.length && cli - i <= 20) {
      const line = lines[cli];
      let j = ccol;
      let done = false;
      while (j < line.length) {
        const ch = line[j];
        if (ch === '\\') { t += ch + (line[j + 1] ?? ''); j += 2; continue; }
        if (ch === closer) { done = true; break; }
        if (q === '(' && ch === '(') return null;
        t += ch;
        j++;
      }
      if (done) return { title: t, endLine: cli, endCol: j + 1 };
      t += '\n';
      cli++;
      ccol = 0;
      if (cli < lines.length && RE_BLANK.test(lines[cli])) return null;
    }
    return null;
  };
  let title = null;
  let endLine = destLine;
  const rest = lines[destLine].slice(col);
  if (/^[ \t]*$/.test(rest)) {
    // Title may live on the following line(s); failure there is harmless.
    const nl = destLine + 1;
    if (nl < lines.length && !RE_BLANK.test(lines[nl])) {
      const tcol = lines[nl].search(/[^ \t]/);
      const tq = lines[nl][tcol];
      if (tq === '"' || tq === "'" || tq === '(') {
        const st = scanTitle(nl, tcol);
        if (st && /^[ \t]*$/.test(lines[st.endLine].slice(st.endCol))) {
          title = st.title;
          endLine = st.endLine;
        }
      }
    }
  } else if (/^[ \t]/.test(rest)) {
    // Same-line title: mandatory clean ending.
    const tcol = col + (rest.length - rest.replace(/^[ \t]+/, '').length);
    const st = scanTitle(destLine, tcol);
    if (!st) return null;
    if (!/^[ \t]*$/.test(lines[st.endLine].slice(st.endCol))) return null;
    title = st.title;
    endLine = st.endLine;
  } else {
    // Text glued to the destination: not a definition.
    return null;
  }
  return {
    lines: endLine - i + 1,
    label,
    href: unescapeString(href),
    title: title === null ? null : unescapeString(title),
  };
}

const TAGLIKE = '(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t"\'=<`]+|\'[^\']*\'|"[^"]*"))?)*[ \\t]*\\/?>|<\\/[A-Za-z][A-Za-z0-9-]*[ \\t]*>)';
const RE_TAGLINE = new RegExp('^(?:' + TAGLIKE + '[ \\t]*)+$');
const RE_SINGLE_TAG = new RegExp('^' + TAGLIKE + '$');

// Detect the start of an HTML block on a line. Returns
// { kind, blockTag, closing } where kind is 'comment' | 'pi' | 'decl' |
// 'cdata' | 'rawtag' (script/pre/style/textarea) | 'block' | 'tagline',
// or null. `blockTag` says the leading tag is a known block-level tag.
function htmlBlockStart(line) {
  const m = /^ {0,3}(<.*)$/.exec(line);
  if (!m) return null;
  const s = m[1];
  if (s.startsWith('<!--')) return { kind: 'comment', blockTag: false, closing: false };
  if (s.startsWith('<?')) return { kind: 'pi', blockTag: false, closing: false };
  if (s.startsWith('<![CDATA[')) return { kind: 'cdata', blockTag: false, closing: false };
  if (/^<![A-Z]/.test(s)) return { kind: 'decl', blockTag: false, closing: false };
  const tagM = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (!tagM) return null;
  const closing = tagM[1] === '/';
  const tag = tagM[2].toLowerCase();
  const after = s.slice(tagM[0].length);
  const afterOk = after === '' || /^[\s>]/.test(after) || after.startsWith('/>');
  if ((tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') && !closing) {
    if (afterOk) return { kind: 'rawtag', tag, blockTag: false, closing };
    return null;
  }
  if (BLOCK_TAGS.has(tag)) {
    if (afterOk) return { kind: 'block', blockTag: true, closing };
    return null;
  }
  // A line consisting of exactly one complete tag is also a block.
  if (RE_SINGLE_TAG.test(s.trim())) return { kind: 'tagline', blockTag: false, closing };
  return null;
}

// Whether an HTML block starting on this line may interrupt a paragraph.
function htmlInterrupts(hb) {
  if (!hb) return false;
  if (hb.kind === 'comment' || hb.kind === 'pi' || hb.kind === 'decl' || hb.kind === 'cdata') return true;
  if (hb.kind === 'rawtag') return !hb.closing;
  if (hb.kind === 'block') return hb.blockTag;
  return false;
}

// Parse a list marker at the start of a line (already indent-stripped to
// the current container level is NOT assumed; line is raw).
// Returns { bullet: char|null, num: number|null, markerEnd, contentIndent }
// measured in columns from line start, or null.
function listMarker(line, baseCol) {
  baseCol = baseCol || 0;
  let i = 0;
  let cols = 0;
  while (i < line.length && cols < 4) {
    if (line[i] === ' ') { cols++; i++; }
    else if (line[i] === '\t') { cols += 4 - ((baseCol + cols) % 4); i++; }
    else break;
  }
  if (cols > 3) return null;
  const indentCols = cols;
  const ch = line[i];
  let bullet = null;
  let num = null;
  let markerLen = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = ch;
    markerLen = 1;
  } else if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j - i < 10) j++;
    if (j - i > 9) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    num = parseInt(line.slice(i, j), 10);
    bullet = d;
    markerLen = (j - i) + 1;
  } else return null;
  const afterPos = i + markerLen;
  // Following whitespace: 1-4 columns, or end of line.
  let wcols = 0;
  let j = afterPos;
  let firstWsEnd = -1;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') wcols += 1;
    else wcols += 4 - ((baseCol + indentCols + markerLen + wcols) % 4);
    j++;
    if (firstWsEnd === -1) firstWsEnd = j;
    if (wcols > 4) break;
  }
  const wsEnd = j;
  const eol = line.slice(afterPos).trim() === '';
  if (!eol && wcols === 0) return null;
  let contentIndent;
  let contentPos;
  if (eol || wcols > 4) {
    contentIndent = indentCols + markerLen + 1;
    contentPos = eol ? line.length : firstWsEnd;
  } else {
    contentIndent = indentCols + markerLen + wcols;
    contentPos = wsEnd;
  }
  return { bullet, num, indentCols, markerWidth: markerLen, afterPos, contentPos, contentIndent, ordered: num !== null };
}

// The text of a list item's first line, expressed in the item's content
// coordinates (column zero = contentIndent). Whitespace before that
// column is dropped; a tab straddling it leaves its remaining width as
// spaces, so later characters keep their true absolute columns.
function itemFirstContent(line, lm, baseCol) {
  const target = lm.contentIndent;
  let cols = lm.indentCols + lm.markerWidth;
  let out = '';
  let i = lm.afterPos;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') break;
    const w = ch === ' ' ? 1 : 4 - ((baseCol + cols) % 4);
    if (cols + w > target) out += ' '.repeat(cols + w - Math.max(cols, target));
    cols += w;
    i++;
  }
  return out + line.slice(i);
}

// Strip `indent` columns from the start of a line; returns the remaining
// text, or null when the line has fewer columns of indentation (and is not
// blank). Partially-consumed tabs leave spaces behind.
// Strip `indent` columns from a line. `baseCol` is the absolute column
// the line starts at in the original source (container strips accumulate
// it), so tab widths are computed against true source columns.
function stripIndent(line, indent, expandTab, baseCol) {
  baseCol = baseCol || 0;
  let cols = 0;
  let i = 0;
  let partial = '';
  while (i < line.length && cols < indent) {
    const ch = line[i];
    if (ch === ' ') { cols++; i++; }
    else if (ch === '\t') {
      const add = 4 - ((baseCol + cols) % 4);
      if (cols + add <= indent) { cols += add; i++; }
      else {
        // The tab straddles the strip boundary: its remaining width
        // stays behind as spaces.
        partial = ' '.repeat(cols + add - indent);
        cols += add;
        i++;
        break;
      }
    } else break;
  }
  if (cols < indent) {
    return RE_BLANK.test(line) ? '' : null;
  }
  if (expandTab) {
    // Container stripping (list items): materialise the rest of the
    // leading whitespace run as spaces, so any tab keeps the width it
    // had at its original column.
    let out = partial;
    let c = cols;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      if (line[i] === ' ') { out += ' '; c++; i++; }
      else {
        const add = 4 - ((baseCol + c) % 4);
        out += ' '.repeat(add);
        c += add;
        i++;
      }
    }
    return out + line.slice(i);
  }
  return partial + line.slice(i);
}

// Split a table row into cells on every unescaped pipe (code spans do
// not protect pipes). Leading/trailing pipes are dropped.
function splitRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const s = line.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      // An escaped pipe is cell content, not a separator; it loses its
      // backslash here (even inside code spans, per the reference).
      cur += s[i + 1] === '|' ? '|' : ch + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch;
    i++;
  }
  cells.push(cur);
  // Drop empty edge cells produced by leading/trailing pipes.
  if (cells.length > 1 && cells[0].trim() === '' ) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim());
}

function isDelimiterRow(line) {
  if (!line.includes('-') || !line.includes('|')) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) align.push('center');
    else if (c.endsWith(':')) align.push('right');
    else if (c.startsWith(':')) align.push('left');
    else align.push(null);
  }
  return align;
}

// Strip up to `indent` columns of leading whitespace (never fails):
// used for lazy continuation lines, which keep whatever indentation is
// left after removing as much as the container would.
// Strip up to `indent` leading whitespace CHARACTERS (a space or a
// tab counts as one character) from a fenced-code content line.
function stripFenceChars(line, indent) {
  let i = 0;
  while (i < line.length && i < indent && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

// Strip up to `indent` columns from a fenced-code content line. When
// the strip actually consumes part of the leading whitespace run, the
// rest of the run is materialised as spaces at its original columns;
// with a zero indent the line stays byte-for-byte verbatim.
function stripFenceLine(line, indent, baseCol) {
  if (indent <= 0) return line;
  const r = stripIndent(line, indent, true, baseCol);
  return r !== null ? r : stripUpTo(line, indent, baseCol);
}

function stripUpTo(line, indent, baseCol) {
  baseCol = baseCol || 0;
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < indent) {
    const ch = line[i];
    if (ch === ' ') { cols++; i++; }
    else if (ch === '\t') {
      const add = 4 - ((baseCol + cols) % 4);
      if (cols + add <= indent) { cols += add; i++; }
      else return ' '.repeat(cols + add - indent) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// Whether a list item's gathered lines currently sit inside an
// unclosed fenced code block (fence content is never a lazy line).
function itemFenceOpen(itemLines) {
  let open = null;
  for (const l of itemLines) {
    const fm = RE_FENCE.exec(l);
    if (!fm) continue;
    if (open === null) {
      if (!(fm[1][0] === '`' && fm[2].includes('`'))) open = fm[1];
    } else if (fm[1][0] === open[0] && fm[1].length >= open.length &&
               fm[2].trim() === '') {
      open = null;
    }
  }
  return open !== null;
}

// Whether a line opens a (valid) fenced code block: a backtick fence
// whose info string contains a backtick is not a fence at all.
function isFenceLine(l) {
  const f = RE_FENCE.exec(l);
  return !!f && !(f[1][0] === '`' && f[2].includes('`'));
}

// Whether a block quote's gathered content currently ends inside a
// paragraph (so a lazy continuation line may follow).
function quoteTailIsParagraph(inner) {
  let last = inner[inner.length - 1];
  if (last === undefined || RE_BLANK.test(last)) return false;
  // Look through nested containers (quote markers, list markers) to the
  // deepest content line.
  for (;;) {
    const st = stripQuoteMarker(last, 0);
    if (st !== null) { last = st.text; continue; }
    const lm = listMarker(last, 0);
    if (lm !== null) { last = itemFirstContent(last, lm, 0); continue; }
    break;
  }
  if (measureIndent(last, 0, 4, 0).cols >= 4) return false;
  if (RE_ATX.test(last) || isFenceLine(last) || RE_HR.test(last) ||
      RE_QUOTE.test(last) || RE_SETEXT.test(last)) return false;
  if (listMarker(last, 0)) return false;
  if (htmlBlockStart(last)) return false;
  return true;
}

// The block lexer: turns an array of source lines into a token list,
// registering link reference definitions into state.defs as it goes.
// `inItem` marks list-item content, where an ordered list with any start
// number may interrupt the item's paragraph. `meter`, when given,
// records whether a blank line separated two blocks at this level
// (which is what makes a list loose).
function lexBlocks(lines, state, inItem, baseCol, meter, lazySet) {
  baseCol = baseCol || 0;
  const tokens = [];
  let i = 0;
  const n = lines.length;
  let blankSeen = false;
  while (i < n) {
    const line = lines[i];
    if (RE_BLANK.test(line)) {
      if (tokens.length) blankSeen = true;
      i++;
      continue;
    }
    if (blankSeen) {
      if (meter) meter.blankBetween = true;
      blankSeen = false;
    }

    // Fenced code
    let m = RE_FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const ch = fence[0];
      const info = m[2].trim();
      if (!(ch === '`' && info.includes('`'))) {
        const indent = line.match(/^ */)[0].length;
        const body = [];
        i++;
        let closed = false;
        while (i < n) {
          const cl = lines[i];
          const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(cl);
          if (cm && cm[1][0] === ch && cm[1].length >= fence.length) { closed = true; i++; break; }
          // Backtick fences strip up to the opener's indent in chars;
          // tilde fences leave their body lines untouched.
          body.push(ch === '`' ? stripFenceChars(cl, Math.min(indent, 3)) : cl);
          i++;
        }
        void closed;
        if (body.length && body[body.length - 1] === '') body.pop();
        tokens.push({ type: 'code', text: body.length ? body.join('\n') + '\n' : '', lang: info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1').split(/[ \t]/)[0] || '' });
        continue;
      }
    }

    // ATX heading
    m = RE_ATX.exec(line);
    if (m && !(m[2] === undefined && line.trim() === '')) {
      let text = (m[2] ?? '').replace(/[ \t]+$/, '');
      text = text.replace(/(^|[ \t])#+$/, '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      tokens.push({ type: 'heading', depth: m[1].length, text });
      i++;
      continue;
    }

    // Thematic break
    if (RE_HR.test(line)) { tokens.push({ type: 'hr' }); i++; continue; }

    // HTML block
    const hb = htmlBlockStart(line);
    if (hb) {
      const body = [line];
      i++;
      if (hb.kind === 'comment') {
        while (i < n && !body[body.length - 1].includes('-->')) { body.push(lines[i]); i++; }
      } else if (hb.kind === 'pi') {
        while (i < n && !body[body.length - 1].includes('?>')) { body.push(lines[i]); i++; }
      } else if (hb.kind === 'decl') {
        while (i < n && !body[body.length - 1].includes('>')) { body.push(lines[i]); i++; }
      } else if (hb.kind === 'cdata') {
        while (i < n && !body[body.length - 1].includes(']]>')) { body.push(lines[i]); i++; }
      } else if (hb.kind === 'rawtag') {
        const closeRe = new RegExp('</' + hb.tag + '>', 'i');
        while (i < n && !closeRe.test(body[body.length - 1])) { body.push(lines[i]); i++; }
      } else {
        while (i < n && !RE_BLANK.test(lines[i])) { body.push(lines[i]); i++; }
      }
      // Terminator-ended blocks keep the newline that ends their last
      // line whenever a following line exists and is not exactly empty
      // (whitespace-only lines count as content here). Blank-terminated
      // blocks lose it, except when the block runs to the empty
      // artefact of a trailing newline at the end of the input.
      const termKind = hb.kind === 'comment' || hb.kind === 'pi' ||
                       hb.kind === 'decl' || hb.kind === 'cdata' ||
                       hb.kind === 'rawtag';
      const atFinalEmpty = i === n - 1 && lines[i] === '';
      const sep = (termKind && i < n && lines[i] !== '') || atFinalEmpty ? '\n' : '';
      tokens.push({ type: 'html', text: body.join('\n'), sep });
      continue;
    }

    // Block quote
    if (RE_QUOTE.test(line)) {
      const inner = [];
      let quoteCols = 2;
      let openFence = null;
      const trackFence = (txt) => {
        const fm = RE_FENCE.exec(txt);
        if (!fm) return;
        if (openFence === null) {
          if (!(fm[1][0] === '`' && fm[2].includes('`'))) openFence = fm[1];
        } else if (fm[1][0] === openFence[0] && fm[1].length >= openFence.length &&
                   /^[`~]+[ \t]*$/.test(txt.trim())) {
          openFence = null;
        }
      };
      const lazyIdx = new Set();
      while (i < n) {
        const l = lines[i];
        const strippedQ = stripQuoteMarker(l, baseCol);
        if (strippedQ !== null) { inner.push(strippedQ.text); quoteCols = strippedQ.cols; trackFence(strippedQ.text); i++; continue; }
        if (RE_BLANK.test(l)) break;
        // Laziness: a paragraph continuation line may omit the marker.
        // It is only possible while the quote's current block is a
        // paragraph (its last line is paragraph text) and no fenced
        // code block is open inside the quote.
        if (openFence === null && inner.length &&
            quoteTailIsParagraph(inner) &&
            !RE_ATX.test(l) && !isFenceLine(l) && !RE_HR.test(l) &&
            !RE_QUOTE.test(l) && !listMarker(l, baseCol) && !htmlInterrupts(htmlBlockStart(l))) {
          let lazyLine = l;
          const ind = measureIndent(l, 0, 5, baseCol);
          if (ind.cols >= 4) lazyLine = stripIndent(l, 4, false, baseCol) ?? l;
          if (RE_SETEXT.test(lazyLine)) {
            // A lazy setext underline after a multi-line paragraph is
            // kept as paragraph text, indented four columns.
            let tail = 0;
            for (let k = inner.length - 1; k >= 0 && !RE_BLANK.test(inner[k]); k--) tail++;
            if (tail >= 2) lazyLine = '    ' + lazyLine;
          }
          lazyIdx.add(inner.length);
          inner.push(lazyLine);
          i++;
          continue;
        }
        break;
      }
      tokens.push({ type: 'blockquote', tokens: lexBlocks(inner, state, false, 0, undefined, lazyIdx) });
      continue;
    }

    // List
    const lm = listMarker(line, baseCol);
    if (lm) {
      const res = lexList(lines, i, lm, state, baseCol);
      tokens.push(res.token);
      i = res.next;
      // The list may have swallowed a blank run at its end; that blank
      // still separates the list from the following block.
      if (res.endBlank && i < n) blankSeen = true;
      continue;
    }

    // Indented code (cannot interrupt a paragraph; we are at a block start)
    {
      const ind = measureIndent(line, 0, 4, baseCol);
      if (ind.cols >= 4) {
        const body = [];
        while (i < n) {
          const l = lines[i];
          if (RE_BLANK.test(l)) {
            // Look ahead: blank lines belong to the code block only when a
            // later indented line follows.
            let j = i;
            while (j < n && RE_BLANK.test(lines[j])) j++;
            if (j < n && measureIndent(lines[j], 0, 4, baseCol).cols >= 4) {
              for (let k = i; k < j; k++) body.push(stripIndent(lines[k], 4, false, baseCol) ?? '');
              i = j;
              continue;
            }
            break;
          }
          const stripped = stripIndent(l, 4, false, baseCol);
          if (stripped === null) break;
          body.push(stripped);
          i++;
        }
        while (body.length && body[body.length - 1] === '') body.pop();
        tokens.push({ type: 'code', text: body.join('\n') + '\n', lang: '' });
        continue;
      }
    }

    // Paragraph / setext heading / table: gather the chunk.
    const chunk = [line];
    i++;
    let setext = 0;
    while (i < n) {
      let l = lines[i];
      if (RE_BLANK.test(l)) {
        // A whitespace-only final line still belongs to the paragraph.
        if (i === n - 1 && chunk.length && l.length > 0) { chunk.push(l); i++; }
        break;
      }
      // Inside a list item, a paragraph continuation line that is still
      // indented by four or more columns after the item dedent has
      // those four columns folded away (lazy lines included).
      if (inItem && measureIndent(l, 0, 4, baseCol).cols >= 4) {
        l = stripIndent(l, 4, false, baseCol) ?? l;
      }
      if (lazySet && lazySet.has(i)) { chunk.push(l); i++; continue; }
      const sm = RE_SETEXT.exec(l);
      if (sm && chunk.length >= 1) { setext = sm[1][0] === '=' ? 1 : 2; i++; break; }
      // Table: second line is a delimiter row.
      if (chunk.length === 1) {
        const align = isDelimiterRow(l);
        if (align) {
          const header = splitRow(chunk[0]);
          if (header.length === align.length) {
            i++;
            const rows = [];
            while (i < n) {
              const rl = lines[i];
              if (RE_BLANK.test(rl)) {
                // A line of spaces and exactly one tab still counts as
                // a (empty) row; any other blank line ends the table.
                if (/^ *\t$/.test(rl)) { rows.push(splitRow(rl)); i++; continue; }
                break;
              }
              // A body row ends at a line that starts another block.
              if (RE_QUOTE.test(rl) || isFenceLine(rl) || RE_ATX.test(rl) ||
                  RE_HR.test(rl) || listMarker(rl, baseCol) || htmlBlockStart(rl) ||
                  measureIndent(rl, 0, 4, baseCol).cols >= 4) break;
              rows.push(splitRow(rl));
              i++;
            }
            tokens.push({ type: 'table', header, align, rows });
            chunk.length = 0;
            break;
          }
        }
      }
      if (interruptsParagraph(l, chunk, inItem, baseCol)) break;
      chunk.push(l);
      i++;
    }
    if (chunk.length === 0) continue; // consumed as a table
    if (setext) {
      // Extract defs from the chunk first: definitions cannot be part of a
      // heading in practice, but a leading def line stays a def.
      const rest = extractDefs(chunk, state);
      if (rest.length) {
        tokens.push({ type: 'heading', depth: setext, text: rest.join('\n').trim() });
      } else {
        // The chunk was only definitions: the underline line starts a
        // fresh block instead of making a heading.
        i = i - 1;
      }
      continue;
    }
    const rest = extractDefs(chunk, state);
    if (rest.length) tokens.push({ type: 'paragraph', text: rest.join('\n') });
  }
  return tokens;
}

// Lines that end an open paragraph (when they appear after its first line).
function interruptsParagraph(l, chunk, inItem, baseCol) {
  if (RE_ATX.test(l)) return true;
  const f = RE_FENCE.exec(l);
  if (f && !(f[1][0] === '`' && f[2].includes('`'))) return true;
  if (RE_QUOTE.test(l)) return true;
  if (RE_HR.test(l)) return true;
  const lm = listMarker(l, baseCol);
  if (lm) {
    // An empty list item cannot interrupt a paragraph.
    if (l.slice(lm.afterPos).trim() === '') return false;
    if (!lm.ordered) return true;
    if (lm.num === 1 || inItem) return true;
  }
  const hb = htmlBlockStart(l);
  if (htmlInterrupts(hb)) return true;
  void chunk;
  return false;
}

// Peel link reference definitions off the START of a paragraph chunk
// (only leading definitions count). Registers them in state.defs; the
// first definition of a label wins. Returns the remaining text lines.
function extractDefs(chunk, state) {
  let i = 0;
  while (i < chunk.length) {
    const d = tryParseDef(chunk, i);
    if (!d) break;
    const key = normaliseLabel(d.label);
    if (key && !state.defs.has(key)) {
      state.defs.set(key, { href: d.href, title: d.title });
    }
    i += d.lines;
  }
  return chunk.slice(i);
}

// Lex a whole list starting at lines[start] whose first marker is firstLm.
// Returns { token, next }.
function lexList(lines, start, firstLm, state, baseCol) {
  baseCol = baseCol || 0;
  const items = [];
  let endBlank = false;
  let i = start;
  let loose = false;
  const ordered = firstLm.ordered;
  const bulletChar = ordered ? null : firstLm.bullet;
  const delimChar = ordered ? firstLm.bullet : null;
  while (i < lines.length) {
    const lm = i === start ? firstLm : listMarker(lines[i], baseCol);
    if (!lm) break;
    if (lm.ordered !== ordered) break;
    if (!ordered && lm.bullet !== bulletChar) break;
    if (ordered && lm.bullet !== delimChar) break;
    // First line content: the text after the marker and its whitespace.
    const firstLine = lines[i];
    const contentIndent = lm.contentIndent;
    const itemLines = [itemFirstContent(firstLine, lm, baseCol)];
    const itemLazy = new Set();
    i++;
    let itemSawBlank = false;
    let pendingBlanks = 0;
    let lastWasBlankRun = false;
    // Fence tracking for gathering: once a fence opener is gathered and
    // its first body line is indented to the item level (or blank), the
    // whole fence body belongs to the item, whatever its indentation.
    // If the first body line is not indented, the item ends instead and
    // the fence stays empty.
    let fenceMode = null;
    let pendingFence = null;
    const noteLine = (txt) => {
      const fm = RE_FENCE.exec(txt);
      if (fenceMode) {
        if (fm && fm[1][0] === fenceMode.ch && fm[1].length >= fenceMode.len &&
            fm[2].trim() === '') fenceMode = null;
        return;
      }
      if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
        pendingFence = { ch: fm[1][0], len: fm[1].length };
      }
    };
    noteLine(itemLines[0]);
    while (i < lines.length) {
      const l = lines[i];
      if (pendingFence && !fenceMode) {
        if (RE_BLANK.test(l) ||
            stripIndent(l, contentIndent, true, baseCol) !== null) {
          fenceMode = pendingFence;
        }
        pendingFence = null;
      }
      if (fenceMode) {
        const txt = stripFenceLine(l, contentIndent, baseCol);
        itemLines.push(txt);
        noteLine(txt);
        i++;
        continue;
      }
      if (RE_BLANK.test(l)) {
        // Decide whether the list/item continues after the blank run.
        let j = i;
        while (j < lines.length && RE_BLANK.test(lines[j])) j++;
        if (j >= lines.length) { i = j; lastWasBlankRun = true; break; }
        if (RE_HR.test(lines[j])) { i = j; lastWasBlankRun = true; break; }
        // An item with no content yet does not resume after a blank line.
        if (itemLines.every((x) => x === '')) {
          const fLm = listMarker(lines[j], baseCol);
          if (fLm && fLm.ordered === ordered &&
              (!ordered ? fLm.bullet === bulletChar : fLm.bullet === delimChar) &&
              fLm.indentCols < contentIndent) loose = true;
          i = j; lastWasBlankRun = true; break;
        }
        const nextLm = listMarker(lines[j], baseCol);
        const stripped = stripIndent(lines[j], contentIndent, true, baseCol);
        if (nextLm && nextLm.ordered === ordered &&
            (!ordered ? nextLm.bullet === bulletChar : nextLm.bullet === delimChar) &&
            nextLm.indentCols < contentIndent) {
          // Next item follows a blank line: loose (unless first item edge).
          loose = true;
          i = j;
          lastWasBlankRun = true;
          break;
        }
        if (stripped !== null) {
          // More content in this item after a blank line.
          itemSawBlank = true;
          pendingBlanks = j - i;
          for (let k = 0; k < pendingBlanks; k++) itemLines.push('');
          i = j;
          continue;
        }
        // List is over.
        i = j;
        lastWasBlankRun = true;
        break;
      }
      const stripped = stripIndent(l, contentIndent, true, baseCol);
      if (stripped !== null) {
        itemLines.push(stripped);
        noteLine(stripped);
        i++;
        continue;
      }
      // A new item at this level?
      const nlm = listMarker(l, baseCol);
      if (nlm && nlm.indentCols < contentIndent) break;
      // Thematic break ends the list (unless it is a setext underline for
      // the item paragraph, handled by the recursive lexer only when the
      // line was stripped — here it is not, so it ends the list).
      if (RE_HR.test(l) && !itemLines.length) break;
      // Laziness: paragraph continuation lines may be unindented, but
      // only while the item's tail is a paragraph (never inside an
      // open fence or after another block). Lazy lines stay verbatim.
      const lastLine = itemLines[itemLines.length - 1];
      if (lastLine !== undefined && lastLine !== '' &&
          fenceMode === null && !isFenceLine(lastLine) &&
          !RE_ATX.test(l) && !isFenceLine(l) && !RE_QUOTE.test(l) &&
          !RE_HR.test(l) && !htmlInterrupts(htmlBlockStart(l))) {
        itemLazy.add(itemLines.length);
        itemLines.push(l);
        i++;
        continue;
      }
      break;
    }
    void itemSawBlank;
    endBlank = lastWasBlankRun;
    // Trim trailing blank lines of the item.
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    const meter = {};
      items.push(lexBlocks(itemLines, state, true, 0, meter, itemLazy));
      if (meter.blankBetween) loose = true;
    // Continue with the next item if the next line is a matching marker.
    if (i >= lines.length) break;
    if (RE_HR.test(lines[i])) break;
    const nlm = listMarker(lines[i], baseCol);
    if (!nlm || nlm.ordered !== ordered) break;
    if (!ordered && nlm.bullet !== bulletChar) break;
    if (ordered && nlm.bullet !== delimChar) break;
  }
  return {
    token: { type: 'list', ordered, start: ordered ? firstLm.num : 1, loose, items },
    next: i,
    endBlank,
  };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const RE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const RE_EMAIL_LINK = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const RE_TAG = new RegExp(
  '^(?:<' + TAG_NAME + '(?:[ \\t\\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t\\n]*=[ \\t\\n]*(?:[^ \\t\\n"\'=<`]+|\'[^\']*\'|"[^"]*"))?)*[ \\t\\n]*\\/?>' +
  '|</' + TAG_NAME + '[ \\t\\n]*>' +
  '|<!-->|<!--->|<!--(?:[^-]|-(?!->))*-->' +
  '|<\\?[\\s\\S]*?\\?>' +
  '|<!' + '[A-Za-z]+' + '[\\s\\S]*?>' +
  '|<\\!\\[CDATA\\[[\\s\\S]*?\\]\\]>)');

// Find the index of the ']' that closes a bracket opened just before pos,
// honouring escapes, code spans and nested brackets. Returns -1 if none.
function findClosingBracket(s, pos) {
  let depth = 1;
  let i = pos;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      // Skip a code span. An unmatched run is literal text and does
      // not hide the closing bracket. A complete span whose content
      // itself contains a backtick defeats the link entirely.
      let n = 0;
      while (s[i] === '`') { n++; i++; }
      let j = i;
      let closedSpan = false;
      let closeStart = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let m = 0;
          const st = j;
          while (s[j] === '`') { m++; j++; }
          if (m === n) { closedSpan = true; closeStart = st; break; }
        } else j++;
      }
      if (closedSpan) {
        // A span whose content contains a backtick is only tolerated
        // when it sits at the very end of the link text.
        if (s.slice(i, closeStart).includes('`') && s[j] !== ']') return -1;
        i = j;
      }
      continue;
    }
    if (ch === '<') {
      // A tag-like span is skipped whole: brackets inside it (including
      // inside attribute values) do not count.
      const tm = RE_TAG.exec(s.slice(i));
      if (tm) { i += tm[0].length; continue; }
      const nx = s[i + 1];
      if (nx !== undefined && /[A-Za-z/!?]/.test(nx)) {
        const gt = s.indexOf('>', i + 1);
        if (gt !== -1) { i = gt + 1; continue; }
      }
      i++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Parse an inline destination + optional title starting at s[pos] === '('.
// Returns { href, title, end } (end just past ')') or null.
function parseInlineDest(s, pos) {
  let i = pos + 1;
  const skipWs = () => {
    let sawNl = false;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) {
      if (s[i] === '\n') sawNl = true;
      i++;
    }
    return sawNl;
  };
  skipWs();
  let href = '';
  if (s[i] === '<') {
    i++;
    const start = i;
    while (i < s.length && s[i] !== '>' && s[i] !== '\n') {
      if (s[i] === '\\') i++;
      i++;
    }
    if (s[i] !== '>') return null;
    href = s.slice(start, i);
    i++;
  } else {
    let depth = 0;
    const start = i;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
      if (ch === '(') depth++;
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    href = s.slice(start, i);
  }
  const afterDest = i;
  const sawWs = skipWs() || i > afterDest;
  let title = null;
  if (s[i] !== ')') {
    if (!sawWs) return null;
    const q = s[i];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const closer = q === '(' ? ')' : q;
    i++;
    const start = i;
    let ok = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === closer) { ok = true; break; }
      if (q === '(' && ch === '(') return null;
      if (q === '"' && ch === '\n' && false) return null;
      i++;
    }
    if (!ok) return null;
    title = s.slice(start, i);
    i++;
    skipWs();
  }
  if (s[i] !== ')') return null;
  return { href: unescapeString(href), title: title === null ? null : unescapeString(title), end: i + 1 };
}

const RE_EMAIL_CORE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)+/;

// Match an e-mail core at s[i..]; returns { addr, cand } or null. A
// match is rejected when the character right after it could extend the
// domain (letter/digit would have been consumed; '-' invalidates it).
// A trailing '_' makes it a candidate: the address links only when the
// underscore run actually closes an emphasis span around it.
function matchEmailCore(s, i) {
  const m = RE_EMAIL_CORE.exec(s.slice(i));
  if (!m) return null;
  const addr = m[0];
  const local = addr.slice(0, addr.indexOf('@'));
  if (local.startsWith('.') || local.endsWith('.')) return null;
  const next = s[i + addr.length];
  if (next !== undefined && /[A-Za-z0-9-]/.test(next)) return null;
  return { addr, cand: next === '_' };
}

// Extended autolinks in running text (GFM): www., http://, https://,
// ftp://, bare e-mail addresses, and mailto:/xmpp: prefixed addresses.
function matchExtendedAutolink(s, i) {
  const head = s.slice(i, i + 8).toLowerCase();
  // mailto:address — the prefix is part of the link text.
  if (head.startsWith('mailto:')) {
    const em = matchEmailCore(s, i + 7);
    const addr = em && !em.cand ? em.addr : null;
    if (addr) {
      const text = s.slice(i, i + 7) + addr;
      return { text, href: 'mailto:' + addr, end: i + text.length };
    }
    return null;
  }
  // xmpp:address[/segment] — one optional single-segment path.
  if (head.startsWith('xmpp:')) {
    const em = matchEmailCore(s, i + 5);
    const addr = em && !em.cand ? em.addr : null;
    if (addr) {
      let text = s.slice(i, i + 5) + addr;
      let end = i + text.length;
      if (s[end] === '/') {
        let j = end + 1;
        while (j < s.length && !isSpace(s[j]) && s[j] !== '<' && s[j] !== '/') j++;
        if (j > end + 1) {
          text += trimAutolink(s.slice(end, j));
          end = i + text.length;
        }
      }
      return { text, href: text, end };
    }
    return null;
  }
  let protocol = null;
  if (s.startsWith('www.', i)) protocol = 'www';
  else if (head.startsWith('http://')) protocol = 'http';
  else if (head.startsWith('https://')) protocol = 'https';
  else if (head.startsWith('ftp://')) protocol = 'ftp';
  if (protocol) {
    let j = i;
    while (j < s.length && !isSpace(s[j]) && s[j] !== '<') j++;
    let text = s.slice(i, j);
    text = trimAutolink(text);
    if (text.length <= (protocol === 'www' ? 4 : protocol.length + 3)) return null;
    if (protocol === 'www') {
      return { text, href: 'http://' + text, end: i + text.length };
    }
    return { text, href: text, end: i + text.length };
  }
  return null;
}

function trimAutolink(text) {
  let t = text;
  // Trailing punctuation and unbalanced trailing ')' are trimmed one
  // character at a time.
  for (;;) {
    if (!t.length) return t;
    const last = t[t.length - 1];
    if ('?!.,:*_~'.includes(last)) { t = t.slice(0, -1); continue; }
    if (last === ';') {
      // A trailing named-entity lookalike leaves the link entirely;
      // a numeric one only loses its semicolon.
      const named = /&[A-Za-z][A-Za-z0-9]*;$/.exec(t);
      if (named) { t = t.slice(0, t.length - named[0].length); continue; }
      t = t.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let opens = 0;
      let closes = 0;
      for (const c of t) { if (c === '(') opens++; else if (c === ')') closes++; }
      if (closes > opens) { t = t.slice(0, -1); continue; }
    }
    break;
  }
  // An unmatched '(' (when the link does not end in ')') ends the link
  // just before the first unclosed parenthesis.
  if (t[t.length - 1] !== ')') {
    const opens = [];
    for (let k = 0; k < t.length; k++) {
      if (t[k] === '(') opens.push(k);
      else if (t[k] === ')') opens.pop();
    }
    if (opens.length) t = t.slice(0, opens[0]);
  }
  return t;
}

// Parse inline markup in `s` into HTML. `defs` is the definition map.
// Links may not contain links: `tracker`, when given, records whether a
// link was formed, so a caller parsing candidate link text can reject the
// outer link when an inner one won.
function parseInline(s, ctx, tracker, inLink) {
  const defs = ctx.defs;
  const nodes = [];
  let text = '';
  const flushText = () => {
    if (text) { nodes.push({ t: 'text', s: text }); text = ''; }
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flushText();
        nodes.push({ t: 'break' });
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        // An escaped character is literal: it must not be reinterpreted
        // (e.g. \& must not become an entity reference start).
        flushText();
        nodes.push({ t: 'esc', ch: nx });
        i += 2;
        continue;
      }
      text += ch; i++; continue;
    }
    if (ch === '\n') {
      // Hard break when the line ends with two or more spaces.
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, '');
        flushText();
        nodes.push({ t: 'break' });
        i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      text += ch; i++; continue;
    }
    if (ch === '`') {
      let run = 0;
      while (s[i] === '`') { run++; i++; }
      // Find a closing run of exactly the same length.
      let j = i;
      let found = -1;
      let foundEnd = -1;
      while (j < n) {
        if (s[j] === '`') {
          let m = 0;
          const st = j;
          while (s[j] === '`') { m++; j++; }
          if (m === run) { found = st; foundEnd = j; break; }
        } else j++;
      }
      if (found === -1) {
        text += '`'.repeat(run);
        continue;
      }
      let content = s.slice(i, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText();
      nodes.push({ t: 'html', s: '<code>' + escapeCode(content) + '</code>' });
      i = foundEnd;
      continue;
    }
    if (ch === '<') {
      const rest = s.slice(i);
      let m = RE_AUTOLINK.exec(rest);
      if (m) {
        flushText();
        const url = m[1];
        nodes.push({ t: 'html', s: '<a href="' + escapeAttr(cleanHref(url)) + '">' + escapeText(url) + '</a>' });
        i += m[0].length;
        continue;
      }
      m = RE_EMAIL_LINK.exec(rest);
      if (m) {
        flushText();
        const addr = m[1];
        nodes.push({ t: 'html', s: '<a href="mailto:' + escapeAttr(addr) + '">' + escapeText(addr) + '</a>' });
        i += m[0].length;
        continue;
      }
      m = RE_TAG.exec(rest);
      if (m) {
        flushText();
        nodes.push({ t: 'html', s: m[0] });
        // A raw <a> tag switches the rest of the document's inline
        // stream into "inside a link" mode (extended autolinks and
        // bare emails stop linking) until a </a> tag appears.
        if (/^<a\s/i.test(m[0])) ctx.inLink = true;
        else if (/^<\/a\s*>/.test(m[0])) ctx.inLink = false;
        i += m[0].length;
        continue;
      }
      text += ch; i++; continue;
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const isImage = ch === '!';
      const openPos = isImage ? i + 1 : i;
      const close = findClosingBracket(s, openPos + 1);
      if (close !== -1) {
        const linkText = s.slice(openPos + 1, close);
        let href = null;
        let title = null;
        let end = -1;
        const after = close + 1;
        if (s[after] === '(') {
          const d = parseInlineDest(s, after);
          if (d) { href = d.href; title = d.title; end = d.end; }
        }
        if (end === -1 && s[after] === '[') {
          const close2 = findClosingBracket(s, after + 1);
          if (close2 !== -1) {
            const rawLabel = s.slice(after + 1, close2);
            const label = rawLabel === '' ? linkText : rawLabel;
            const def = defs.get(normaliseLabel(label));
            if (def) { href = def.href; title = def.title; end = close2 + 1; }
          }
        }
        if (end === -1 && s[after] !== '[') {
          // Shortcut reference (also the fallback when an inline
          // destination fails to parse).
          const def = defs.get(normaliseLabel(linkText));
          if (def) { href = def.href; title = def.title; end = after; }
        }
        if (end !== -1) {
          if (isImage) {
            flushText();
            const alt = plainText(linkText, ctx);
            let tag = '<img src="' + escapeAttr(cleanHref(href)) + '" alt="' + escapeAttr(alt) + '"';
            if (title !== null) tag += ' title="' + escapeAttr(title) + '"';
            tag += '>';
            nodes.push({ t: 'html', s: tag });
            i = end;
            continue;
          }
          const innerTracker = { link: false };
          const inner = parseInline(linkText, ctx, innerTracker, true);
          if (!innerTracker.link) {
            flushText();
            let tag = '<a href="' + escapeAttr(cleanHref(href)) + '"';
            if (title !== null) tag += ' title="' + escapeAttr(title) + '"';
            tag += '>' + inner + '</a>';
            nodes.push({ t: 'html', s: tag });
            if (tracker) tracker.link = true;
            i = end;
            continue;
          }
          // An inner link won: the outer brackets stay literal.
        }
      }
      text += ch; i++; continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (s[i] === ch) { run++; i++; }
      flushText();
      nodes.push({ t: 'delim', ch, len: run, origLen: run, s: s.slice(i - run, i) });
      continue;
    }
    // Extended autolinks starting inside running text.
    const chLow = (ch >= 'A' && ch <= 'Z') ? ch.toLowerCase() : ch;
    if (!inLink && !ctx.inLink &&
        (chLow === 'w' || chLow === 'h' || chLow === 'f' || chLow === 'm' || chLow === 'x') &&
        (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]))) {
      const auto = matchExtendedAutolink(s, i);
      if (auto) {
        flushText();
        nodes.push({ t: 'html', s: '<a href="' + escapeAttr(cleanHref(auto.href)) + '">' + escapeText(auto.text) + '</a>' });
        i = auto.end;
        continue;
      }
    }
    if (!inLink && !ctx.inLink &&
        (ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') &&
        (i === 0 || !/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[i - 1]))) {
      const em = matchEmailCore(s, i);
      if (em) {
        flushText();
        if (em.cand) {
          // Followed by an underscore run: only a link when that run
          // turns out to close an emphasis span around this address
          // (decided after delimiter processing).
          nodes.push({ t: 'emailcand', s: em.addr });
        } else {
          nodes.push({ t: 'html', s: '<a href="mailto:' + escapeAttr(em.addr) + '">' + escapeText(em.addr) + '</a>' });
        }
        i += em.addr.length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flushText();
  processEmphasis(nodes, s);
  resolveEmailCands(nodes, false);
  return renderNodes(nodes);
}

// Decide candidate bare e-mail nodes: an address followed by an
// underscore run is a link only when the run closed an emphasis span
// around it — visible now as the address being the last child of an
// element, or the following delimiter having been partly consumed.
function resolveEmailCands(nodes, insideElem) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'elem') { resolveEmailCands(nd.children, true); continue; }
    if (nd.t !== 'emailcand') continue;
    const next = nodes[k + 1];
    const approved = (insideElem && k === nodes.length - 1) ||
      (next !== undefined && next.t === 'delim' && next.len < next.origLen);
    if (approved) {
      nd.t = 'html';
      nd.s = '<a href="mailto:' + escapeAttr(nd.s) + '">' + escapeText(nd.s) + '</a>';
    } else {
      nd.t = 'text';
    }
  }
}

// Plain-text content of a markup string (for image alt attributes).
function plainText(s, ctx) {
  // Render inline, then strip tags and unescape the few entities the
  // renderer emits; alt text keeps the literal characters.
  const html = parseInline(s, ctx, undefined);
  return html.replace(/<img[^>]*? alt="([^"]*)"[^>]*?>/g, '$1')
             .replace(/<[^>]*>/g, '')
             .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
             .replace(/&amp;/g, '&');
}

// Neighbour characters for flanking tests: element-like nodes (links,
// code spans, raw HTML) end/start with punctuation in the source, so they
// report '!'; hard breaks report a space.
function nodeCharBefore(nodes, idx) {
  for (let k = idx - 1; k >= 0; k--) {
    const nd = nodes[k];
    if (nd.t === 'text') return nd.s[nd.s.length - 1];
    if (nd.t === 'delim') return nd.ch;
    if (nd.t === 'break') return ' ';
    return '!';
  }
  return null;
}

function nodeCharAfter(nodes, idx) {
  for (let k = idx + 1; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'text') return nd.s[0];
    if (nd.t === 'delim') return nd.ch;
    if (nd.t === 'break') return ' ';
    return '!';
  }
  return null;
}

// CommonMark-style delimiter processing for *, _ and ~~.
function processEmphasis(nodes) {
  // Compute flanking for delimiter runs.
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.t !== 'delim') continue;
    const before = nodeCharBefore(nodes, idx);
    const after = nodeCharAfter(nodes, idx);
    const beforeWs = before === null || isSpace(before);
    const afterWs = after === null || isSpace(after);
    const beforePunct = before !== null && !beforeWs && isPunct(before);
    const afterPunct = after !== null && !afterWs && isPunct(after);
    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
    if (nd.ch === '_') {
      nd.canOpen = leftFlanking && (!rightFlanking || beforePunct);
      nd.canClose = rightFlanking && (!leftFlanking || afterPunct);
    } else if (nd.ch === '~') {
      nd.canOpen = !afterWs && after !== '~';
      nd.canClose = !beforeWs && before !== '~';
    } else {
      nd.canOpen = leftFlanking;
      nd.canClose = rightFlanking;
    }
  }
  // Match closers to openers.
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (!closer || closer.t !== 'delim' || !closer.canClose || closer.len === 0) { ci++; continue; }
    const need = 1;
    if (closer.len < need) { ci++; continue; }
    // Find nearest matching opener before ci.
    let oi = -1;
    for (let k = ci - 1; k >= 0; k--) {
      const op = nodes[k];
      if (op.t === 'delim' && op.ch === closer.ch && op.canOpen && op.len >= need &&
          (closer.ch !== '~' || (op.origLen === closer.origLen && op.origLen <= 2))) {
        // Rule of three for * and _.
        if (closer.ch !== '~' &&
            (op.canClose || closer.canOpen) &&
            (op.origLen + closer.origLen) % 3 === 0 &&
            !(op.origLen % 3 === 0 && closer.origLen % 3 === 0)) {
          continue;
        }
        oi = k;
        break;
      }
    }
    if (oi === -1) { ci++; continue; }
    const opener = nodes[oi];
    let use;
    let tag;
    if (closer.ch === '~') { use = opener.len; tag = 'del'; }
    else if (opener.len >= 2 && closer.len >= 2) { use = 2; tag = 'strong'; }
    else { use = 1; tag = 'em'; }
    opener.len -= use;
    closer.len -= use;
    const inner = nodes.splice(oi + 1, ci - oi - 1);
    const el = { t: 'elem', tag, children: inner };
    nodes.splice(oi + 1, 0, el);
    // Adjust ci: the element now sits at oi+1; closer shifted.
    ci = oi + 2;
    // If closer exhausted, move on; otherwise retry the same closer.
    if (closer.len === 0 || (closer.ch === '~' && closer.len < 2)) ci++;
    else {
      // Recompute position of closer: it is right after the element.
      ci = oi + 2;
    }
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += escapeText(nd.s);
    else if (nd.t === 'esc') out += escapeChar(nd.ch);
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'break') out += '<br>';
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.t === 'elem') out += '<' + nd.tag + '>' + renderNodes(nd.children) + '</' + nd.tag + '>';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderTokens(tokens, state, tight) {
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    switch (tok.type) {
      case 'heading':
        out += '<h' + tok.depth + '>' + parseInline(tok.text, state, false) + '</h' + tok.depth + '>\n';
        break;
      case 'paragraph':
        if (tight) {
          out += parseInline(tok.text, state, false);
        } else {
          out += '<p>' + parseInline(tok.text, state, false) + '</p>\n';
        }
        break;
      case 'code':
        out += '<pre><code' + (tok.lang ? ' class="language-' + escapeAttr(tok.lang) + '"' : '') + '>' +
               escapeCode(tok.text) + '</code></pre>\n';
        break;
      case 'html':
        out += tok.text + (tok.sep ?? '');
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens, state, false) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(tok, state);
        break;
      case 'table':
        out += renderTable(tok, state);
        break;
    }
  }
  return out;
}

function renderList(list, state) {
  let out = list.ordered
    ? (list.start !== 1 ? '<ol start="' + list.start + '">\n' : '<ol>\n')
    : '<ul>\n';
  for (const item of list.items) {
    out += renderListItem(item, list, state);
  }
  out += list.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function renderListItem(item, list, state) {
  // Task list items: a leading [ ] / [x] in the first paragraph.
  let checkbox = null;
  if (item.length && item[0].type === 'paragraph') {
    const m = /^\[([ xX])\] /.exec(item[0].text);
    if (m) {
      checkbox = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      item = item.slice();
      item[0] = { ...item[0], text: item[0].text.slice(m[0].length) };
    } else if (/^\[([ xX])\]$/.test(item[0].text)) {
      const mm = /^\[([ xX])\]$/.exec(item[0].text);
      checkbox = mm[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      item = item.slice();
      item[0] = { ...item[0], text: '' };
    }
  }
  const tight = !list.loose;
  let inner;
  if (checkbox && item.length && item[0].type === 'paragraph') {
    // The checkbox lives inside the first paragraph (or, in a tight list,
    // directly in front of its bare inline content).
    const first = item[0];
    const firstHtml = tight
      ? checkbox + parseInline(first.text, state, false)
      : '<p>' + checkbox + parseInline(first.text, state, false) + '</p>\n';
    inner = firstHtml + renderTokens(item.slice(1), state, tight);
  } else {
    inner = renderTokens(item, state, tight);
    if (checkbox) inner = checkbox + inner;
  }
  return '<li>' + inner + '</li>\n';
}

function renderTable(tok, state) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < tok.header.length; c++) {
    const a = tok.align[c];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
           parseInline(tok.header[c], state, false) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (tok.rows.length) {
    out += '<tbody>';
    for (const row of tok.rows) {
      out += '<tr>\n';
      for (let c = 0; c < tok.header.length; c++) {
        const a = tok.align[c];
        out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
               parseInline(row[c] ?? '', state, false) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') markdown = String(markdown ?? '');
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const state = { defs: new Map(), inLink: false };
  const tokens = lexBlocks(lines, state);
  // Mark html tokens that run to end-of-input (no trailing newline added).
  markEof(tokens, lines);
  return renderTokens(tokens, state, false);
}

// An html block that is the very last thing in its container and reaches
// the final line renders without a trailing newline.
function markEof(tokens, lines) {
  void lines;
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.type === 'blockquote') markEof(tok.tokens, lines);
    if (tok.type === 'list') for (const item of tok.items) markEof(item, lines);
  }
  const last = tokens[tokens.length - 1];
  if (last && last.type === 'html') last.eof = true;
}
