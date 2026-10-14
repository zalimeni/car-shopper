// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { ListingMemo, MarkdownView, parseImport } = await import("../src/App.jsx");
const { MEMO_MAX } = await import("../src/markdown.js");

const box = () => screen.getByRole("textbox", { name: /Listing notes/ });

describe("MarkdownView renders safely", () => {
  it("shows hostile input as inert text: no script/img/handlers, no javascript: links", () => {
    const { container } = render(<MarkdownView text={'<script>window.__x=1</script> <img src=x onerror="window.__x=2"> [click](javascript:window.__x=3) [ok](https://example.com/a)'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/<img/i);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/a"]);
    expect(container.textContent).toContain("<script>window.__x=1</script>"); // visible, as text
    expect(window.__x).toBeUndefined();
    cleanup();
  });
  it("opens links in a new tab without leaking the opener", () => {
    const { container } = render(<MarkdownView text="[ok](https://example.com)" />);
    const a = container.querySelector("a");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    cleanup();
  });
  it("renders formatting: bold, headings, lists, checklists, quotes, code", () => {
    const { container } = render(<MarkdownView text={"# Plan\n**call** them\n\n- [ ] ask about doc fee\n- [x] Carfax clean\n\n> maybe\n\n```\nVIN 123\n```"} />);
    expect(container.querySelector("strong").textContent).toBe("call");
    expect(container.querySelector("[role=heading]").textContent).toBe("Plan");
    expect(screen.getByRole("img", { name: "to do" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "done" })).toBeTruthy();
    expect(container.querySelector("blockquote").textContent).toBe("maybe");
    expect(container.querySelector("pre").textContent).toBe("VIN 123");
    cleanup();
  });
});

describe("ListingMemo", () => {
  it("starts as a quiet 'Add notes' button when there are none", () => {
    render(<ListingMemo l={{}} onSave={() => {}} />);
    expect(screen.getByText(/Add notes/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    cleanup();
  });
  it("writes, counts characters, previews, and saves trimmed text", () => {
    const onSave = vi.fn();
    render(<ListingMemo l={{}} onSave={onSave} />);
    fireEvent.click(screen.getByText(/Add notes/));
    expect(screen.getByText("0 / 4,000")).toBeTruthy();
    expect(screen.getByText("Save notes").disabled).toBe(true); // nothing to save yet
    fireEvent.change(box(), { target: { value: "**Great** deal  \n\n" } });
    expect(screen.getByText("18 / 4,000")).toBeTruthy();
    fireEvent.click(screen.getByText("Preview"));
    expect(document.querySelector("strong").textContent).toBe("Great");
    fireEvent.click(screen.getByText("Save notes"));
    expect(onSave).toHaveBeenCalledWith("**Great** deal");
    cleanup();
  });
  it("caps input at the limit: maxLength on the box, and a hard clamp on save even if it's bypassed", () => {
    const onSave = vi.fn();
    render(<ListingMemo l={{}} onSave={onSave} />);
    fireEvent.click(screen.getByText(/Add notes/));
    expect(box().getAttribute("maxlength")).toBe(String(MEMO_MAX));
    fireEvent.change(box(), { target: { value: "x".repeat(MEMO_MAX + 500) } }); // a paste that dodged maxLength
    fireEvent.click(screen.getByText("Save notes"));
    expect(onSave.mock.calls[0][0].length).toBe(MEMO_MAX);
    cleanup();
  });
  it("warns as the limit nears", () => {
    render(<ListingMemo l={{}} onSave={() => {}} />);
    fireEvent.click(screen.getByText(/Add notes/));
    fireEvent.change(box(), { target: { value: "x".repeat(3700) } });
    expect(screen.getByText("3,700 / 4,000").style.color).toBe("rgb(212, 160, 23)"); // amber
    fireEvent.change(box(), { target: { value: "x".repeat(4000) } });
    expect(screen.getByText("4,000 / 4,000").style.color).toBe("rgb(204, 68, 68)");  // red
    expect(screen.getByText("Limit reached")).toBeTruthy();
    cleanup();
  });
  it("shows existing notes rendered, edits them, and Cancel / Escape discard changes", () => {
    const onSave = vi.fn();
    render(<ListingMemo l={{ memo: "- one\n- two" }} onSave={onSave} />);
    expect(document.querySelectorAll("li").length).toBe(2);
    fireEvent.click(screen.getByText("Edit notes"));
    expect(box().value).toBe("- one\n- two");
    fireEvent.change(box(), { target: { value: "changed" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelectorAll("li").length).toBe(2);
    fireEvent.click(screen.getByText("Edit notes"));
    fireEvent.change(box(), { target: { value: "changed" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    cleanup();
  });
  it("Ctrl+Enter saves", () => {
    const onSave = vi.fn();
    render(<ListingMemo l={{ memo: "a" }} onSave={onSave} />);
    fireEvent.click(screen.getByText("Edit notes"));
    fireEvent.change(box(), { target: { value: "ab" } });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("ab");
    cleanup();
  });
  it("can clear notes entirely", () => {
    const onSave = vi.fn();
    render(<ListingMemo l={{ memo: "old" }} onSave={onSave} />);
    fireEvent.click(screen.getByText("Edit notes"));
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.click(screen.getByText("Save notes"));
    expect(onSave).toHaveBeenCalledWith("");
    cleanup();
  });
  it("folds long notes behind Show more", () => {
    const long = Array.from({ length: 30 }, (_, i) => "line " + i).join("\n");
    render(<ListingMemo l={{ memo: long }} onSave={() => {}} />);
    fireEvent.click(screen.getByText(/Show more/));
    expect(screen.getByText(/Show less/)).toBeTruthy();
    cleanup();
  });
});

describe("notes survive export -> import, clamped, as their own field", () => {
  const row = (over) => Object.assign({ vehicle: "Toyota RAV4", year: 2021, price: 24000, profileId: "p1", notes: "↓ Price $25,000 → $24,000", rejectReason: "too many miles" }, over);
  it("keeps memo separate from notes and rejectReason", () => {
    const r = parseImport(JSON.stringify([row({ memo: "## Call Tuesday\n- ask about fees" })]), ["p1"]);
    expect(r.errors).toEqual([]);
    expect(r.listings[0]).toMatchObject({ memo: "## Call Tuesday\n- ask about fees", notes: "↓ Price $25,000 → $24,000", rejectReason: "too many miles" });
  });
  it("clamps an oversized memo to the limit", () => {
    const r = parseImport(JSON.stringify([row({ memo: "y".repeat(9000) })]), ["p1"]);
    expect(r.listings[0].memo.length).toBe(MEMO_MAX);
  });
  it("defaults to empty when absent", () => {
    expect(parseImport(JSON.stringify([row()]), ["p1"]).listings[0].memo).toBe("");
  });
});
