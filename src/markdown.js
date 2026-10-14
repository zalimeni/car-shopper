// A small, safe Markdown parser for listing notes. Pure: text in, plain tree out.
//
// Safe by construction: it never produces HTML, only a tree of typed nodes that
// the UI turns into React elements (so everything is escaped as text). Raw HTML
// in the source is just text. Links keep only http(s) URLs — anything else
// (javascript:, data:, ...) degrades to its label. Images are not supported.
//
// Supported: # headings, paragraphs (a single newline is a line break, like a
// chat/comment box), **bold**, *italic* / _italic_, ~~strike~~, `code`, fenced
// ``` blocks, > quotes, - / * / + and 1. lists (nested by indent), - [ ] / - [x]
// task items, --- rules, [text](url) links and bare http(s) URLs.

// "A page or so": ~4,000 characters is roughly a page of single-spaced notes
// (600-700 words) — plenty for a listing, and small enough that a full set of
// maxed-out notes keeps the one-blob app state comfortably small.
export const MEMO_MAX = 4000;

export function clampMemo(v) { return String(v == null ? "" : v).slice(0, MEMO_MAX); }

// ── inline ──
const PUNCT = "\\`*_{}[]()#+-.!~>|";

function isHttp(u) { return /^https?:\/\//i.test(u); }

// -> [{ t: "text", v } | { t: "b"|"i"|"s", c: [...] } | { t: "code", v } | { t: "a", href, c: [...] }]
export function parseInline(src) {
  const s = String(src || "");
  const out = [];
  let buf = "";
  const flush = function () { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const rest = s.slice(i);

    if (ch === "\n") { flush(); out.push({ t: "br" }); i++; continue; }

    if (ch === "\\" && i + 1 < s.length && PUNCT.indexOf(s[i + 1]) > -1) { buf += s[i + 1]; i += 2; continue; }

    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }

    // bold / strike: ** __ ~~
    const two = s.substr(i, 2);
    if (two === "**" || two === "__" || two === "~~") {
      // "__" is only emphasis at word edges (so __init__ and a__b__c stay text): the
      // opener can't follow a letter/digit and the closer can't precede one.
      const wordy = function (c) { return /[A-Za-z0-9]/.test(c || ""); };
      const openOk = two !== "__" || !wordy(s[i - 1]);
      let end = openOk ? s.indexOf(two, i + 2) : -1;
      while (end > -1 && two === "__" && wordy(s[end + 2])) end = s.indexOf(two, end + 1);
      while (end > -1 && s[end + 2] === two[0]) end++; // "***": close on the LAST two of the run
      if (end > i + 2 && !/^\s/.test(s[i + 2]) && !/\s$/.test(s.slice(i + 2, end))) {
        flush(); out.push({ t: two === "~~" ? "s" : "b", c: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue;
      }
    }

    // italic: * or _ (underscore only at a word edge, so snake_case stays text)
    if ((ch === "*" || ch === "_") && s[i + 1] !== ch && s[i - 1] !== ch && !/\s/.test(s[i + 1] || " ")) {
      const prev = s[i - 1] || " ";
      if (ch === "*" || !/[A-Za-z0-9]/.test(prev)) {
        let end = i + 1;
        while ((end = s.indexOf(ch, end)) > -1) {
          if (!/\s/.test(s[end - 1]) && (ch === "*" || !/[A-Za-z0-9]/.test(s[end + 1] || " "))) break;
          end++;
        }
        if (end > i + 1) { flush(); out.push({ t: "i", c: parseInline(s.slice(i + 1, end)) }); i = end + 1; continue; }
      }
    }

    // [label](url)
    if (ch === "[") {
      const m = rest.match(/^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/); // url may hold one level of (parens)
      if (m) {
        flush();
        if (isHttp(m[2])) out.push({ t: "a", href: m[2], c: parseInline(m[1]) });
        else out.push.apply(out, parseInline(m[1])); // unsafe scheme: keep the label, drop the link
        i += m[0].length; continue;
      }
    }

    // bare URL
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(rest)) {
      const m = rest.match(/^https?:\/\/[^\s<>]+/i);
      let url = m[0].replace(/[.,;:!?)\]]+$/, "");
      flush(); out.push({ t: "a", href: url, c: [{ t: "text", v: url }] }); i += url.length; continue;
    }

    buf += ch; i++;
  }
  flush();
  return out;
}

// ── blocks ──
const RE_FENCE = /^\s*```/;
const RE_HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function startsBlock(line) {
  return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) || RE_ITEM.test(line);
}

// -> blocks: { type: "heading", level, c } | { type: "p", lines: [inline[]] } | { type: "quote", blocks }
//    | { type: "code", text } | { type: "hr" } | { type: "list", ordered, items: [{ checked, c, children: [list] }] }
export function parseMarkdown(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines);
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (RE_FENCE.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // closing fence (or end of text)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    let m = line.match(RE_HEAD);
    if (m) { blocks.push({ type: "heading", level: m[1].length, c: parseInline(m[2]) }); i++; continue; }

    if (RE_HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { body.push(lines[i].match(RE_QUOTE)[1]); i++; }
      blocks.push({ type: "quote", blocks: parseBlocks(body) });
      continue;
    }

    if (RE_ITEM.test(line)) {
      const items = [];
      while (i < lines.length && (RE_ITEM.test(lines[i]) || (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length))) {
        const im = lines[i].match(RE_ITEM);
        if (im) items.push({ indent: im[1].replace(/\t/g, "  ").length, ordered: /\d/.test(im[2]), text: im[3] });
        else items[items.length - 1].text += "\n" + lines[i].trim(); // indented continuation
        i++;
      }
      blocks.push(buildList(items));
      continue;
    }

    // paragraph: runs until a blank line or the start of another block
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
    blocks.push({ type: "p", lines: para.map(function (l) { return parseInline(l.trim()); }) });
  }
  return blocks;
}

// Turn a flat run of (indent, text) items into nested lists. Depth is capped so
// a pathological paste can't build a skyscraper.
function buildList(items) {
  const MAX_DEPTH = 4;
  const root = { type: "list", ordered: items[0].ordered, items: [] };
  const stack = [{ indent: items[0].indent, list: root }];
  items.forEach(function (it) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (it.indent > top.indent && top.list.items.length && stack.length < MAX_DEPTH) {
      const parent = top.list.items[top.list.items.length - 1];
      const child = { type: "list", ordered: it.ordered, items: [] };
      parent.children.push(child);
      stack.push({ indent: it.indent, list: child });
      top = stack[stack.length - 1];
    }
    const task = it.text.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
    top.list.items.push({
      checked: task ? task[1] !== " " : null,
      c: parseInline(task ? task[2] : it.text),
      children: [],
    });
  });
  return root;
}
