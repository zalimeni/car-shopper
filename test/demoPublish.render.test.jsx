// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

// Publish demo (admins): the checklist lists the owner's notes, unchecked ones
// are cleared, secrets never leave, and the newest queued cars are held back.
vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } }));
const { DemoPublishModal } = await import("../src/Demo.jsx");

describe("Publish demo", () => {
  it("sends a scrubbed snapshot with only the kept notes", async () => {
    const sent = [];
    window.fetch = async (u, init) => { sent.push({ u, body: JSON.parse(init.body), auth: init.headers.Authorization }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    const data = {
      settings: { marketcheckKeys: [{ key: "mc-secret" }], budget: 40000 },
      listings: [{ id: "a", vin: "A1", year: 2021, make: "Subaru", model: "Outback", status: "watch", memo: "call Dana" },
                 { id: "b", vin: "B1", year: 2022, make: "Toyota", model: "RAV4", status: "watch", notes: "nice color" }],
      skipped: [],
    };
    render(<DemoPublishModal data={data} candidates={[{ vin: "C1", id: "c", addedDate: "2026-11-01" }]} onClose={() => {}} />);
    expect(screen.getByText("Your notes (2)")).toBeTruthy();
    expect(screen.getByText("call Dana")).toBeTruthy();
    fireEvent.click(screen.getByText("nice color")); // keep this one
    fireEvent.click(screen.getByText("Publish"));
    await screen.findByText(/Published/);
    const { u, body, auth } = sent[0];
    expect(u).toBe("/api/snapshots");
    expect(auth).toBe("Bearer tok");
    expect(JSON.stringify(body)).not.toContain("mc-secret");
    expect(body.demo.data.listings.map((l) => l.memo || l.notes || "")).toEqual(["", "nice color"]);
    expect(body.demo.pool.map((c) => c.vin)).toEqual(["C1"]);
  });
});
