import { describe, it, expect, vi } from "vitest";

const calls = [];
const removed = [];
vi.mock("../src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: {} }) },
  storage: { from: () => ({
    createSignedUrls: async (paths) => {
      calls.push(paths);
      return { data: paths.map((p) => (p.indexOf("gone") > -1 ? { path: p, signedUrl: null, error: "Either the object does not exist" } : { path: p, signedUrl: "https://x.supabase.co/sign/" + p, error: null })), error: null };
    },
    remove: async (paths) => { removed.push(...paths); return { data: [], error: null }; },
  }) },
} }));

const { signPhotoKeys, signedPhotoUrl, missing, removePhotos, copyPhotos } = await import("../src/photos.js");

describe("src/photos.js", () => {
  it("batches signing, caches URLs and remembers missing objects", async () => {
    const r = await signPhotoKeys(["u/A1.jpg", "u/gone.jpg"]);
    expect(r).toEqual({ "u/A1.jpg": "https://x.supabase.co/sign/u/A1.jpg", "u/gone.jpg": null });
    expect(calls).toEqual([["u/A1.jpg", "u/gone.jpg"]]);
    expect(missing["u/gone.jpg"]).toBe(true);
    expect(await signedPhotoUrl("u/A1.jpg")).toBe("https://x.supabase.co/sign/u/A1.jpg");
    expect(await signedPhotoUrl("u/gone.jpg")).toBe(null);
    expect(calls.length).toBe(1); // both answered from memory
  });
  it("removes own objects; copy is a no-op without a session", async () => {
    await removePhotos(["u/A1.jpg", ""]);
    expect(removed).toEqual(["u/A1.jpg"]);
    expect(await copyPhotos([{ vin: "A1", url: "https://d.example/a.jpg" }])).toBe(null);
  });
});
