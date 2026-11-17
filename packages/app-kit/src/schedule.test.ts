import { describe, expect, it } from "vitest";
import { App } from "./app.js";
import type { Runtime, SabhaEnv } from "./context.js";
import { ConfigError } from "./errors.js";
import { due, parseDays } from "./schedule.js";
import { FakeSabha } from "./testing/fake-sabha.js";

const env: SabhaEnv = { SABHA_BASE_URL: "https://sabha.test", SABHA_API_KEY: "sabha_app_key_12345" };
const at = (iso: string) => Date.parse(iso);

describe("due", () => {
  const london = { at: "09:00", timezone: "Europe/London", days: "mon-fri" };

  it("keeps 09:00 Europe/London at 09:00 local on both sides of the clock change", () => {
    expect(due(london, at("2026-03-27T09:00:00Z"), env)).toBe("2026-03-27"); // Friday, GMT
    expect(due(london, at("2026-03-30T08:00:00Z"), env)).toBe("2026-03-30"); // Monday, BST
    expect(due(london, at("2026-03-30T09:00:00Z"), env)).toBeUndefined();
    expect(due(london, at("2026-10-26T09:00:00Z"), env)).toBe("2026-10-26"); // Monday, GMT again
  });

  it("skips days outside the schedule", () => {
    expect(due(london, at("2026-03-28T09:00:00Z"), env)).toBeUndefined(); // Saturday
  });

  it("never fires a local time skipped by spring-forward, unless retryFor covers it", () => {
    const skipped = { at: "02:30", timezone: "America/New_York", days: "daily" };
    for (let minute = 0; minute < 24 * 60; minute++) {
      expect(due(skipped, at("2026-03-08T05:00:00Z") + minute * 60_000, env)).toBeUndefined();
    }
    expect(due({ ...skipped, retryFor: 60 }, at("2026-03-08T07:00:00Z"), env)).toBe("2026-03-08"); // 03:00 EDT
  });

  it("fires a local time repeated by fall-back twice, on the same date", () => {
    const repeated = { at: "01:30", timezone: "America/New_York", days: "daily" };
    expect(due(repeated, at("2026-11-01T05:30:00Z"), env)).toBe("2026-11-01"); // 01:30 EDT
    expect(due(repeated, at("2026-11-01T06:30:00Z"), env)).toBe("2026-11-01"); // 01:30 EST
  });

  it("with retryFor, fires on every tick in the window and not after", () => {
    const spec = { ...london, retryFor: 10 };
    expect(due(spec, at("2026-11-16T09:00:00Z"), env)).toBe("2026-11-16");
    expect(due(spec, at("2026-11-16T09:10:00Z"), env)).toBe("2026-11-16");
    expect(due(spec, at("2026-11-16T09:11:00Z"), env)).toBeUndefined();
    expect(due(spec, at("2026-11-16T08:59:00Z"), env)).toBeUndefined();
  });

  it("reads settings from env", () => {
    const spec = { at: (e: SabhaEnv & { AT?: string }) => e.AT ?? "", timezone: "UTC" };
    expect(due(spec, at("2026-11-16T07:15:00Z"), { ...env, AT: "07:15" })).toBe("2026-11-16");
  });

  it("refuses an unknown timezone, time or days with a ConfigError", () => {
    expect(() => due({ ...london, timezone: "Mars/Olympus" }, Date.now(), env)).toThrow(ConfigError);
    expect(() => due({ ...london, at: "9am" }, Date.now(), env)).toThrow(ConfigError);
    expect(() => parseDays("someday")).toThrow(ConfigError);
  });

  it("parses lists and ranges of days, wrapping past Sunday", () => {
    expect([...parseDays("mon-wed,fri")].sort()).toEqual([1, 2, 3, 5]);
    expect([...parseDays("fri-mon")].sort()).toEqual([0, 1, 5, 6]);
    expect(parseDays("daily").size).toBe(7);
  });
});

describe("App.runSchedules", () => {
  const runtime = (): Runtime => {
    const sabha = new FakeSabha().app(env.SABHA_API_KEY, { id: 1, name: "Bot" });
    const app = new App({ fetch: sabha.fetch });
    return { env, client: app.clientFor(env), logger: { info() {}, warn() {}, error() {} }, transport: "webhook", waitUntil() {} };
  };

  it("runs every due schedule, with a runKey for the local day, and isolates failures", async () => {
    const app = new App();
    const keys: string[] = [];
    app.schedule("prompt", { at: "09:00", timezone: "Europe/London" }, ({ runKey }) => void keys.push(runKey));
    app.schedule("broken", { at: "09:00", timezone: "Europe/London" }, () => {
      throw new Error("down");
    });
    app.schedule("later", { at: "17:00", timezone: "Europe/London" }, () => void keys.push("later"));
    const results = await app.runSchedules(at("2026-11-16T09:00:00Z"), runtime());
    expect(keys).toEqual(["prompt:2026-11-16"]);
    expect(results.find((result) => result.name === "broken")?.error).toBeInstanceOf(Error);
    expect(results.find((result) => result.name === "later")?.ran).toBe(false);
  });

  it("reports an invalid timezone as a ConfigError at the first tick", async () => {
    const app = new App();
    app.schedule("bad", { at: "09:00", timezone: "Nowhere/Land" }, () => {});
    const [result] = await app.runSchedules(Date.now(), runtime());
    expect(result?.error).toBeInstanceOf(ConfigError);
  });

  it("refuses two schedules with one name", () => {
    const app = new App();
    app.schedule("a", { at: "09:00", timezone: "UTC" }, () => {});
    expect(() => app.schedule("a", { at: "10:00", timezone: "UTC" }, () => {})).toThrow(ConfigError);
  });
});
