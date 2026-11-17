import { describe, expect, it } from "vitest";
import { stableId } from "./stable-id.js";

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("stableId", () => {
  it("is the same for the same key and app, and shaped as a version 8 UUID", async () => {
    const id = await stableId("sabha_app_one", "standup:prompt:2026-11-16");
    expect(id).toMatch(UUID_V8);
    expect(await stableId("sabha_app_one", "standup:prompt:2026-11-16")).toBe(id);
  });

  it("differs between keys and between apps", async () => {
    const id = await stableId("sabha_app_one", "a");
    expect(await stableId("sabha_app_one", "b")).not.toBe(id);
    expect(await stableId("sabha_app_two", "a")).not.toBe(id);
  });
});
