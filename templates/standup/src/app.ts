// A standup in a thread: each scheduled morning the bot asks in one room, members reply in the
// prompt's thread, and later the bot posts a digest of who said what. Sabha is its only store.
import { App, ConfigError, instantAt, type AppOptions } from "@sabha-co/app-kit";
import type { CloudflareEnv } from "@sabha-co/app-kit/cloudflare";
import { digestHtml, findPrompt, readUpdates } from "./digest.js";

export interface StandupEnv extends CloudflareEnv {
  STANDUP_ROOM_ID: string;
  STANDUP_TIMEZONE: string;
  /** `mon-fri` when unset. */
  STANDUP_DAYS?: string;
  STANDUP_PROMPT_AT: string;
  STANDUP_DIGEST_AT: string;
  STANDUP_PROMPT_TEXT?: string;
}

const DEFAULT_PROMPT = "Good morning! What did you get done yesterday, what's next today, and is anything in your way? Reply in this thread.";

function roomOf(env: StandupEnv): number {
  const id = Number(env.STANDUP_ROOM_ID);
  if (!Number.isInteger(id) || id <= 0) throw new ConfigError("STANDUP_ROOM_ID must be the id of the room the standup runs in");
  return id;
}

export function createStandup(options: AppOptions = {}): App<StandupEnv> {
  const app = new App<StandupEnv>(options);
  const when = (at: (env: StandupEnv) => string) => ({
    at,
    timezone: (env: StandupEnv) => env.STANDUP_TIMEZONE,
    days: (env: StandupEnv) => env.STANDUP_DAYS || "mon-fri",
    retryFor: 10,
  });

  app.schedule("prompt", when((env) => env.STANDUP_PROMPT_AT), async ({ env, client, runKey, stableId }) => {
    const roomId = roomOf(env);
    // Keyed by room too: a client message id is unique across the workspace, so a second
    // standup on the same app, or a room changed mid-day, still posts.
    await client.post(roomId, { body: env.STANDUP_PROMPT_TEXT || DEFAULT_PROMPT, clientMessageId: await stableId(`${runKey}:${roomId}`) });
  });

  app.schedule("digest", when((env) => env.STANDUP_DIGEST_AT), async ({ env, client, logger, localDate, runKey, stableId }) => {
    const roomId = roomOf(env);
    const me = await client.me();
    // From the start of the local day, not the prompt time: on a clock-change day the prompt
    // goes out an hour off its nominal time, and today's first app post is still the prompt.
    const since = instantAt(localDate, "00:00", env.STANDUP_TIMEZONE);
    const prompt = await findPrompt(client, roomId, me.id, since);
    if (!prompt) {
      logger.info("no standup prompt today, so no digest", { room_id: roomId, date: localDate });
      return;
    }
    const updates = prompt.replies ? await readUpdates(client, prompt.replies.room_id, me.id) : [];
    await client.post(roomId, { body: digestHtml(updates, { localDate, threadUrl: prompt.url }), clientMessageId: await stableId(`${runKey}:${roomId}`) });
  });

  return app;
}
