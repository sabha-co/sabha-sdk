# Standup

A standup in a thread. Each scheduled morning the bot asks in one channel, saying when the digest comes; people reply in the prompt's thread, and it puts a ✅ on each reply; later it posts a digest with one line per person and a link to the thread.

It keeps nothing of its own: the prompt and the replies live in Sabha. It runs on Cloudflare's free plan, and needs only the `post` and `read_messages` permissions.

## Set it up

You need a Cloudflare account, Node 24 and pnpm, and to be an admin in Sabha.

1. **Make the app.** In Sabha, go to **Settings → Apps → Add app** and name it (say, "Standup"). Copy its **key** from the **API** tab now: Sabha shows it once.
2. **Set its access.** On the app's **Access** tab, turn on only **Post and react** and **Read messages in its channels**, and under **Channels** keep only the channel the standup runs in. Note the channel's id: the number after `/channels/` in its address.
3. **Set it up.** From a clone of the SDK's repo, in this folder (copying the folder out on its own? Replace `workspace:*` in `package.json` with the dependency in the SDK's README):

   ```bash
   pnpm install
   ```

   In `wrangler.jsonc`, set `SABHA_BASE_URL` to your Sabha's address, `STANDUP_CHANNEL_ID` to the channel's id, and the timezone, days and times under `vars`.

4. **Deploy:**

   ```bash
   pnpm wrangler login
   pnpm wrangler secret put SABHA_API_KEY   # the key from step 1
   pnpm run deploy
   ```

5. **Point Sabha at it.** On the app's **Events** tab, set the webhook URL to the address `pnpm run deploy` printed (`https://sabha-standup.<you>.workers.dev`). Sabha then shows the app's **signing secret**. Set it straight away:

   ```bash
   pnpm wrangler secret put SABHA_SIGNING_SECRET
   ```

   Until it's set the Worker refuses every delivery, and Sabha suspends a webhook after five failed deliveries in a row. Schedules run without it.

The prompt goes out at the next `STANDUP_PROMPT_AT` on a scheduled day. To see it now, set `STANDUP_PROMPT_AT` to a minute or two from now and deploy again.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `STANDUP_CHANNEL_ID` | | The channel the standup runs in. |
| `STANDUP_TIMEZONE` | `Europe/London` | The team's timezone. Times hold across clock changes. |
| `STANDUP_DAYS` | `mon-fri` | `daily`, or a list such as `mon,wed,fri`. |
| `STANDUP_PROMPT_AT` | `09:30` | When to ask. |
| `STANDUP_DIGEST_AT` | `16:00` | When to post the digest. |
| `STANDUP_PROMPT_TEXT` | a short good-morning | What to ask. |
| `TRANSPORT` | `webhook` | `socket` to hold a live connection, so the bot shows online. See below. |

Each schedule fires within ten minutes of its time if a tick is missed, and never twice: a repeated tick finds the first post. If no prompt went out that day, no digest goes out either; the bot never posts a prompt late.

## Show it online

With `TRANSPORT=socket`, a Durable Object holds a connection to Sabha and the bot shows online.

1. Set `TRANSPORT` to `socket` in `wrangler.jsonc` and `pnpm run deploy`.
2. Clear the webhook URL on the app's page in Sabha.
3. Open `https://sabha-standup.<you>.workers.dev/connect` once.

One such app fits the free plan. To go back, set `TRANSPORT` to `webhook`, deploy, and set the webhook URL again.

## Change it

The bot is `src/app.ts`; the digest's text is `digestHtml` in `src/digest.ts`. To try changes locally against a Sabha:

1. Make a second app in Sabha just for development, in a test channel. Don't use the deployed app's key: a local socket on it would race the deployed one.
2. `cp .dev.vars.example .dev.vars` and fill it in.
3. `pnpm dev`, then open `http://localhost:8787/connect`.
4. Set `STANDUP_PROMPT_AT` (in `.dev.vars`) to the coming minute, then `curl "http://localhost:8787/__scheduled"` to fire it.

`pnpm test` runs the tests in Cloudflare's runtime, against a fake Sabha.
