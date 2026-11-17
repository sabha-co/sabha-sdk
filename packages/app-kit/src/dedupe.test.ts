import { describe, expect, it } from "vitest";
import { SeenEvents } from "./dedupe.js";

describe("SeenEvents", () => {
  it("claims a key once until it expires or is released", () => {
    const seen = new SeenEvents(1_000, 10);
    expect(seen.claim("message:1", 0)).toBe(true);
    expect(seen.claim("message:1", 500)).toBe(false);
    expect(seen.claim("message:1", 1_500)).toBe(true);
    seen.release("message:1");
    expect(seen.claim("message:1", 1_600)).toBe(true);
  });

  it("forgets the oldest keys past its size", () => {
    const seen = new SeenEvents(60_000, 2);
    seen.claim("a", 0);
    seen.claim("b", 0);
    seen.claim("c", 0);
    expect(seen.claim("a", 1)).toBe(true);
    expect(seen.claim("c", 1)).toBe(false);
  });
});
