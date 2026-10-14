import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown, clampMemo, MEMO_MAX } from "../src/markdown.js";

const types = (nodes) => nodes.map((n) => n.t);
const text = (nodes) => nodes.map((n) => (n.t === "text" ? n.v : n.c ? text(n.c) : n.v || "")).join("");

describe("limit", () => {
  it("is a round 4,000 characters and clampMemo enforces it", () => {
    expect(MEMO_MAX).toBe(4000);
    expect(clampMemo("x".repeat(5000)).length).toBe(4000);
    expect(clampMemo(null)).toBe("");
    expect(clampMemo(undefined)).toBe("");
    expect(clampMemo(12)).toBe("12");
  });
});

describe("parseInline", () => {
  it("handles bold, italic, strike and code", () => {
    expect(types(parseInline("a **b** *c* _d_ ~~e~~ `f`"))).toEqual(["text", "b", "text", "i", "text", "i", "text", "s", "text", "code"]);
    expect(parseInline("`a *b* c`")[0]).toEqual({ t: "code", v: "a *b* c" }); // no markdown inside code
  });
  it("nests inline styles", () => {
    const [b] = parseInline("**bold and *italic***");
    expect(b.t).toBe("b");
    expect(types(b.c)).toContain("i");
  });
  it("leaves snake_case, stray asterisks, and unmatched markers as text", () => {
    expect(parseInline("my_var_name")).toEqual([{ t: "text", v: "my_var_name" }]);
    expect(parseInline("5 * 3 = 15")).toEqual([{ t: "text", v: "5 * 3 = 15" }]);
    expect(parseInline("**unclosed")).toEqual([{ t: "text", v: "**unclosed" }]);
  });
  it("only treats __ as emphasis at word edges, so __init__ and a__b__c stay text", () => {
    expect(parseInline("call __init__ first")[1].t).toBe("b"); // a real __bold__ at word edges
    expect(parseInline("a__b__c")).toEqual([{ t: "text", v: "a__b__c" }]);
    expect(parseInline("window.__x and window.__y")).toEqual([{ t: "text", v: "window.__x and window.__y" }]);
  });
  it("honours backslash escapes", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([{ t: "text", v: "*not italic*" }]);
  });
  it("makes links from [text](url) and bare URLs, trimming trailing punctuation", () => {
    expect(parseInline("[Carfax](https://x.test/a?b=1)")[0]).toMatchObject({ t: "a", href: "https://x.test/a?b=1" });
    const [pre, a, post] = parseInline("see https://x.test/page, ok");
    expect(a).toMatchObject({ t: "a", href: "https://x.test/page" });
    expect(post.v).toBe(", ok");
  });
  it("keeps a link whose URL contains balanced parentheses", () => {
    expect(parseInline("[wiki](https://en.wikipedia.org/wiki/Kia_(company))")[0]).toMatchObject({ t: "a", href: "https://en.wikipedia.org/wiki/Kia_(company)" });
  });
  it("turns newlines into line breaks", () => {
    expect(types(parseInline("a\nb"))).toEqual(["text", "br", "text"]);
  });
});

describe("safety", () => {
  it("drops non-http(s) link targets, keeping only the label", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd", "//evil.test"]) {
      const out = parseInline("[click me](" + bad + ")");
      expect(out.some((n) => n.t === "a")).toBe(false);
      expect(text(out)).toBe("click me");
    }
  });
  it("treats raw HTML as plain text — there is no HTML output at all", () => {
    const blocks = parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>hi</b>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("p");
    expect(text(blocks[0].lines[0])).toContain("<script>alert(1)</script>");
    expect(JSON.stringify(blocks)).not.toMatch(/"t":"(html|script|img)"/);
  });
  it("does not support images (they'd be tracking pixels)", () => {
    const out = parseInline("![x](https://evil.test/p.png)");
    expect(out.some((n) => n.t === "img")).toBe(false);
  });
  it("survives a deliberately nasty 4,000-char input quickly", () => {
    const nasty = ("*_`[(~".repeat(700)).slice(0, 4000);
    const t0 = Date.now();
    parseMarkdown(nasty);
    parseMarkdown("[".repeat(4000));
    parseMarkdown("**".repeat(2000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("parseMarkdown blocks", () => {
  it("parses headings (levels 1-6)", () => {
    const b = parseMarkdown("# One\n### Three");
    expect(b.map((x) => [x.type, x.level])).toEqual([["heading", 1], ["heading", 3]]);
  });
  it("keeps single newlines as line breaks inside a paragraph, splits on blank lines", () => {
    const b = parseMarkdown("line one\nline two\n\nsecond para");
    expect(b.map((x) => x.type)).toEqual(["p", "p"]);
    expect(b[0].lines.length).toBe(2);
  });
  it("parses bullet, numbered and task lists", () => {
    const [ul] = parseMarkdown("- a\n- b");
    expect(ul).toMatchObject({ type: "list", ordered: false });
    expect(ul.items.length).toBe(2);
    const [ol] = parseMarkdown("1. first\n2. second");
    expect(ol.ordered).toBe(true);
    const [tl] = parseMarkdown("- [ ] call dealer\n- [x] check Carfax");
    expect(tl.items.map((i) => i.checked)).toEqual([false, true]);
    expect(text(tl.items[1].c)).toBe("check Carfax");
  });
  it("nests lists by indentation, with a depth cap", () => {
    const [l] = parseMarkdown("- a\n  - b\n    - c\n- d");
    expect(l.items.length).toBe(2);
    expect(l.items[0].children[0].items[0].children[0].items[0].c[0].v).toBe("c");
    const deep = parseMarkdown(Array.from({ length: 12 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n"))[0];
    let d = 0, cur = deep;
    while (cur && cur.items[0].children[0]) { d++; cur = cur.items[0].children[0]; }
    expect(d).toBeLessThanOrEqual(3);
  });
  it("parses quotes, rules and fenced code (code stays verbatim)", () => {
    expect(parseMarkdown("> quoted *text*")[0]).toMatchObject({ type: "quote" });
    expect(parseMarkdown("---")[0]).toEqual({ type: "hr" });
    expect(parseMarkdown("```\n# not a heading\n- not a list\n```")[0]).toEqual({ type: "code", text: "# not a heading\n- not a list" });
  });
  it("an unclosed fence runs to the end instead of hanging", () => {
    expect(parseMarkdown("```\nstill code")[0]).toEqual({ type: "code", text: "still code" });
  });
  it("handles CRLF and empty input", () => {
    expect(parseMarkdown("a\r\n\r\nb").length).toBe(2);
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
  });
});
