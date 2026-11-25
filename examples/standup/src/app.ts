// A standup in a thread: each scheduled morning the bot asks in one channel, members reply in the
// prompt's thread, and later the bot posts a digest of who said what. Sabha is its only store.
import { App, ConfigError, SabhaApiError, instantAt, localTime, type AppOptions } from "@sabha-co/sdk";
import type { CloudflareEnv } from "@sabha-co/sdk/cloudflare";
import { digestHtml, readUpdates, todaysPosts } from "./digest.js";

export interface StandupEnv extends CloudflareEnv {
  STANDUP_CHANNEL_ID: string;
  STANDUP_TIMEZONE: string;
  /** `mon-fri` when unset. */
  STANDUP_DAYS?: string;
  STANDUP_PROMPT_AT: string;
  STANDUP_DIGEST_AT: string;
  STANDUP_PROMPT_TEXT?: string;
}

const defaultPrompt = (env: StandupEnv) =>
  `Good morning! What did you get done yesterday, what's next today, and is anything in your way? Reply in this thread, and I'll post a digest here at ${env.STANDUP_DIGEST_AT}.`;

function channelOf(env: StandupEnv): number {
  const id = Number(env.STANDUP_CHANNEL_ID);
  if (!Number.isInteger(id) || id <= 0) throw new ConfigError("STANDUP_CHANNEL_ID must be the id of the channel the standup runs in");
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
    const channelId = channelOf(env);
    // Keyed by channel too: a client message id is unique across the workspace, so a second
    // standup on the same app, or a channel changed mid-day, still posts.
    await client.post(channelId, { body: env.STANDUP_PROMPT_TEXT || defaultPrompt(env), clientMessageId: await stableId(`${runKey}:${channelId}`) });
  });

  app.schedule("digest", when((env) => env.STANDUP_DIGEST_AT), async ({ env, client, logger, localDate, runKey, stableId }) => {
    const channelId = channelOf(env);
    const me = await client.me();
    // From the start of the local day, not the prompt time: on a clock-change day the prompt
    // goes out an hour off its nominal time, and today's first app post is still the prompt.
    const since = instantAt(localDate, "00:00", env.STANDUP_TIMEZONE);
    const [prompt] = await todaysPosts(client, channelId, me.id, since);
    if (!prompt) {
      logger.info("no standup prompt today, so no digest", { channel_id: channelId, date: localDate });
      return;
    }
    const updates = prompt.replies ? await readUpdates(client, prompt.replies.channel_id, me.id) : [];
    await client.post(channelId, { body: digestHtml(updates, { localDate, threadUrl: prompt.url }), clientMessageId: await stableId(`${runKey}:${channelId}`) });
  });

  // A ✅ on each reply to today's prompt, so whoever answers sees it counted. None once the
  // digest is out, since a later reply won't be in it.
  app.message({ in: "thread" }, async ({ env, client, message, user }) => {
    const channelId = channelOf(env);
    const thread = message.thread;
    if (thread?.parent_channel_id !== channelId) return;
    const me = await client.me();
    if (user.id === me.id) return;
    const { date } = localTime(Date.parse(message.created_at), env.STANDUP_TIMEZONE);
    const [prompt, digest] = await todaysPosts(client, channelId, me.id, instantAt(date, "00:00", env.STANDUP_TIMEZONE));
    if (prompt?.id !== thread.parent_message_id || digest) return;
    try {
      await client.react(message.id, "✅");
    } catch (error) {
      if (!(error instanceof SabhaApiError && error.code === "already_reacted")) throw error;
    }
  });

  return app;
}
