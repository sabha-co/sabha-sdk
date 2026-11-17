// A notifier: each weekday at 08:30 it fetches a summary and posts it in one room. The stable
// id makes a repeated tick return the first post instead of posting again.
import { App, type SabhaEnv } from "@sabha-co/app-kit";

type Env = SabhaEnv & { ROOM_ID: string; FEED_URL: string; TIMEZONE: string };

export const app = new App<Env>();

app.schedule("morning-summary", { at: "08:30", timezone: (env) => env.TIMEZONE, retryFor: 5 }, async ({ env, client, runKey, stableId }) => {
  const response = await fetch(env.FEED_URL);
  if (!response.ok) throw new Error(`the feed answered ${response.status}`);
  const { summary } = (await response.json()) as { summary: string };
  await client.post(Number(env.ROOM_ID), { text: summary, clientMessageId: await stableId(runKey) });
});
