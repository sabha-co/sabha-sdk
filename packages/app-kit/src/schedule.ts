import type { SabhaClient } from "./client.js";
import { ConfigError } from "./errors.js";
import type { Logger } from "./log.js";
import type { SabhaEnv } from "./context.js";

type Setting<Env, T> = T | ((env: Env) => T);

export interface ScheduleSpec<Env extends SabhaEnv = SabhaEnv> {
  /** Local time, `HH:MM`. */
  at: Setting<Env, string>;
  /** IANA timezone, such as `Europe/London`. */
  timezone: Setting<Env, string>;
  /** `mon-fri` (the default), `daily`, or a list such as `mon,wed,fri` or `mon-wed,sat`. */
  days?: Setting<Env, string>;
  /**
   * Fire again on every tick for this many minutes after `at`, with the same `runKey`, so a
   * missed tick is covered. The handler must then be idempotent, through `stableId(runKey)`.
   */
  retryFor?: Setting<Env, number>;
}

export interface ScheduleContext<Env extends SabhaEnv = SabhaEnv> {
  name: string;
  /** `name:YYYY-MM-DD` in local time: the same for every tick of one day's run. */
  runKey: string;
  /** The local date, `YYYY-MM-DD`. */
  localDate: string;
  scheduledTime: number;
  env: Env;
  client: SabhaClient;
  logger: Logger;
  stableId(key: string): Promise<string>;
}

export type ScheduleHandler<Env extends SabhaEnv> = (context: ScheduleContext<Env>) => unknown | Promise<unknown>;

export interface Schedule<Env extends SabhaEnv = SabhaEnv> {
  name: string;
  spec: ScheduleSpec<Env>;
  handler: ScheduleHandler<Env>;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function resolve<Env, T>(setting: Setting<Env, T>, env: Env): T {
  return typeof setting === "function" ? (setting as (env: Env) => T)(env) : setting;
}

/** The weekdays (0 = Sunday) a `days` setting names. */
export function parseDays(days: string): Set<number> {
  const text = days.trim().toLowerCase();
  if (text === "daily" || text === "*" || text === "every day") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const result = new Set<number>();
  for (const part of text.split(",").map((piece) => piece.trim()).filter(Boolean)) {
    const [from, to] = part.split("-").map((day) => WEEKDAYS.indexOf(day.slice(0, 3)));
    if (from === undefined || from < 0 || (to !== undefined && to < 0)) throw new ConfigError(`schedule days "${days}" isn't understood`);
    if (to === undefined) {
      result.add(from);
    } else {
      for (let day = from; ; day = (day + 1) % 7) {
        result.add(day);
        if (day === to) break;
      }
    }
  }
  return result;
}

function parseAt(at: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new ConfigError(`schedule time "${at}" isn't HH:MM`);
  return hours * 60 + minutes;
}

/** The local date, weekday and minute of the day of an instant in a timezone. */
export function localTime(instant: number, timezone: string): { date: string; weekday: number; minute: number } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ConfigError(`schedule timezone "${timezone}" isn't a known timezone`);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * The instant a local date and time fall on in a timezone, such as today's 09:00 in
 * Europe/London. A time the clocks skip lands just after the change.
 */
export function instantAt(localDate: string, at: string, timezone: string): number {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const minute = parseAt(at);
  const wall = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  let instant = wall;
  for (let pass = 0; pass < 2; pass++) {
    const local = localTime(instant, timezone);
    const [y, m, d] = local.date.split("-").map(Number) as [number, number, number];
    instant += wall - Date.UTC(y, m - 1, d, Math.floor(local.minute / 60), local.minute % 60);
  }
  return instant;
}

/** Whether a schedule fires at this tick, and the local date of the run when it does. */
export function due<Env extends SabhaEnv>(spec: ScheduleSpec<Env>, instant: number, env: Env): string | undefined {
  const local = localTime(instant, resolve(spec.timezone, env));
  const days = parseDays(resolve(spec.days ?? "mon-fri", env));
  const at = parseAt(resolve(spec.at, env));
  const retryFor = Math.max(0, resolve(spec.retryFor ?? 0, env));
  if (!days.has(local.weekday)) return undefined;
  const late = local.minute - at;
  return late >= 0 && late <= retryFor ? local.date : undefined;
}
