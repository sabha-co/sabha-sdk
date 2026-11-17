# Sabha app kit

Build apps for [Sabha](https://sabha.co) in TypeScript: bots, slash commands, buttons, scheduled posts, agents. Write handlers once; run them on Cloudflare Workers or Node, over webhooks or the socket.

```ts
import { App } from "@sabha-co/app-kit";
import { createWorker } from "@sabha-co/app-kit/cloudflare";

const app = new App();

app.mention(({ user }) => `Hi ${user.name}!`);

export default createWorker(app);
```

The kit verifies every delivery, answers inside Sabha's time limits, retries what's safe to retry, and never posts the same reply twice. It runs on Web standards (`fetch`, Web Crypto), so the core has no Node or Workers dependency.

- **Starting from scratch?** Copy [`examples/standup`](examples/standup), a working standup bot you deploy with `wrangler deploy`.
- **Coming from Slack's Bolt?** Read [Porting from Bolt](docs/porting-from-bolt.md).
- **Writing with a coding agent?** Point it at [`AGENTS.md`](AGENTS.md).

## Install

The kit is private for now. Depend on a commit of this repo:

```bash
pnpm add "github:sabha-co/sabha-app-kit#<commit>&path:/packages/app-kit"
```

pnpm builds it on install; list `@sabha-co/app-kit` under `pnpm.onlyBuiltDependencies` so it may. Node 24 or later, or any Workers runtime.

## Settings

| Setting | What it is |
|---|---|
| `SABHA_BASE_URL` | Your Sabha's address, such as `https://team.sabha.co`, or `https://sabha.co/1000001` on Sabha's own hosting. |
| `SABHA_API_KEY` | The app's key, from Settings → Apps. Keep it a secret. |
| `SABHA_SIGNING_SECRET` | The app's signing secret, for webhooks. Keep it a secret. |
| `TRANSPORT` | `webhook` (the default) or `socket`. |
| `SABHA_SOCKET_URL` | Only when the socket isn't at `/cable` on the base URL, such as a local AnyCable. |

An admin makes the app in **Settings → Apps → New**, picks its permissions (ask only for what it uses), sets its webhook URL to where the app runs, and adds it to the rooms it works in.

## Handlers

| Register | Runs on | The context adds | A returned value |
|---|---|---|---|
| `app.mention(h)` | a message that mentions the app | `message`, `room` | is posted as the reply |
| `app.message(h)`, `app.message({ in: "dm" }, h)` | every message the app hears; `in` is `dm`, `thread`, `room` or `post` | `message`, `room` | is posted as the reply |
| `app.reaction(h)`, `app.reaction({ emoji: "👀" }, h)` | a reaction added to a message | `message`, `room`, `reaction` | is posted as the reply |
| `app.command("/name", h)` | a slash command | `command`, `respond` | answers the command |
| `app.action("id" \| /re/, h)` | a click on a control | `action`, `actions`, `respond` | goes to `respond` |
| `app.event("name", h)` | any event: `message_updated`, `message_deleted`, `reaction_deleted`, `user_created`, `user_deleted`, … | | is ignored |
| `app.schedule(name, spec, h)` | a local time on chosen days | see [Schedules](#schedules) | is ignored |

Every handler's context has `event`, `user` (who did it), `env`, `client` (the whole API), `logger`, `say`, `status`, `draft` and `stableId`. Several handlers can match one event; they run together.

- **`say(text | { text, body, blocks, thread })`** posts where the event happened, or in its thread with `thread: true`. Each `say` carries a stable id, so a redelivered event returns the first post instead of posting again.
- **`status("Thinking…")`** shows a line under the conversation; `status(null)` clears it.
- **`draft()`** opens a live draft: `update({ text })` with the whole text so far, then `finish(text)` posts it in the draft's place. Drafts notify no one; the finished post notifies once.
- **`respond(text | { text, blocks, response_type, replace_original })`** answers a command or a click through its `response_url`, which allows five answers in 30 minutes.
- **`client`** is the typed API: `client.post(roomId, { text })`, `client.allMessages(roomId)`, `client.react(messageId, "👍")`, and the rest of Sabha's [API](#the-api).

## Answering in time

Sabha waits a limited time for an answer. The kit answers inside it and keeps every handler running after the answer, through `waitUntil`.

| Event | The kit answers Sabha | A returned value |
|---|---|---|
| `command` | with the first handler's value, if one returns within 3 s | after that, goes to `response_url` (Sabha waits 15 s from the member's command) |
| a message or reaction | with the first string a handler returns within 10 s, when the key holds `post`; otherwise at once | Sabha posts that string as the reply; anything later, or anything else, is posted with `say` |
| anything else | when its handlers finish, within 25 s | is ignored |

Each handler's value is sent as soon as that handler finishes; a slow handler never holds back a quick one.

Each delivery says how long Sabha waits for it, in `X-Sabha-Timeout`, and the kit ends every window in time for its answer to arrive. The same header says whether Sabha will post a reply: it waits 300 s for a message or reaction it will post a string reply to, with no API call, and 30 s otherwise, when the kit answers at once. The kit waits at most 10 s (`replyWindowMs`) for that string even so: Sabha ties up one of its few webhook workers for as long as the kit waits, and a slow handler there holds up every other app's deliveries. A Sabha too old to send the header is judged by the key's permissions instead, read from `GET /me` every few minutes: with `post`, replies go inline. Objects always go through `say`, so they render the same however quick the handler was. `new App({ inlineReplies: false })` (or `true`) overrides the check.

On Cloudflare `waitUntil` allows 30 s after the answer. Past that, see [Long work](#long-work).

## Retrying

Throw `RetryLater` to have Sabha send the event again. The kit answers `503`, and Sabha retries with backoff. Sabha retries `message_updated`, `message_deleted`, `reaction_deleted`, `block_actions`, `user_created` and `user_deleted`. It never retries `message_created`, `reaction_created` or `command`, so `RetryLater` there is logged and dropped: retry inside the handler instead.

The kit drops an event it has already handled, by its key (`ctx.eventKey`), but only for as long as an isolate lives. For an effect outside Sabha that must happen once (charging a card, filing a ticket), key it on `ctx.eventKey` in your own store.

## Transports

Webhooks are the default: Sabha POSTs each event, signed, to the app's URL. It's free on Cloudflare and needs nothing running between events.

The socket keeps a live connection, so the app shows online, needs no public URL, and takes events in order with replay after a drop. Sabha sends every event to both the socket and the webhook; the kit drops the webhook copy while `TRANSPORT=socket`.

| Host | Webhook | Socket |
|---|---|---|
| Cloudflare | `createWorker(app)` | `createWorker(app)` plus the `SocketHost` Durable Object |
| Node 24+ | `handleWebhook(app, request, { env, waitUntil })` in a server that takes Web `Request`s, such as Hono | `runSocket(app, { env })` |
| Anything with `fetch` | `handleWebhook` | `socketApp` with your own `connect` |

### The socket on Cloudflare

1. Export the Durable Object beside the Worker, and declare it (the standup's `wrangler.jsonc` does both):

   ```ts
   export default createWorker(app);
   export const SocketHost = createSocketHost(app);
   ```

2. Set `TRANSPORT=socket` and deploy. Clear the webhook URL on the app's page in Sabha, so Sabha stops sending deliveries the app will drop.
3. Open `https://<your worker>/connect` once. The cron tick reconnects it from then on, as does a 30 s alarm in the object.

To go back, set `TRANSPORT=webhook`, deploy, and set the webhook URL again. The object closes its socket within 30 s and stops.

The object stays awake while the socket is open. One such app fits Cloudflare's free plan (about 10,800 of the 13,000 GB-seconds a day); run more on the paid plan.

## Schedules

```ts
app.schedule("morning", { at: "09:00", timezone: "Europe/London", days: "mon-fri", retryFor: 10 }, async ({ client, runKey, stableId }) => {
  await client.post(roomId, { text: "Good morning", clientMessageId: await stableId(runKey) });
});
```

- `at` is local time in `timezone`, and holds across clock changes.
- `days` is `mon-fri` (the default), `daily`, or a list such as `mon,wed,fri` or `fri-mon`.
- Any setting can be a function of `env`: `{ at: (env) => env.POST_AT }`.
- The host ticks once a minute: a Cron Trigger of `* * * * *` on Cloudflare, a timer in `runSocket`. A missed tick misses the run, unless `retryFor` fires it again on every tick for that many minutes. Make a handler that sets `retryFor` safe to repeat: post with `stableId(runKey)`, where `runKey` is the same for every tick of one day's run.

## Long work

A Worker's `waitUntil` allows 30 s. For longer work, hand it to a [Queue](https://developers.cloudflare.com/queues/) or a [Workflow](https://developers.cloudflare.com/workflows/) you bind, and answer from there with the API:

```ts
app.command("/report", async ({ command, env }) => {
  await env.REPORTS.send({ roomId: command.room_id, responseUrl: command.response_url });
  return { response_type: "ephemeral", text: "Working on it…" };
});
```

## Local development

Run the app on your machine against a Sabha, over the socket, with no tunnel:

1. Make a **separate dev app** in Settings → Apps. Never use the deployed app's key locally: Sabha sends every event to every open socket, so a local socket on the real app would race the deployed one.
2. Put its settings in `.dev.vars` (copy `.dev.vars.example`), with `TRANSPORT=socket`.
3. `pnpm dev` (`wrangler dev --test-scheduled`), then open `http://localhost:8787/connect` to open the socket.
4. Fire the minute's schedules by hand with `curl "http://localhost:8787/__scheduled"`. A schedule runs only at its `at`, so set it to the coming minute while you try it.

## Testing

`@sabha-co/app-kit/testing` has what the kit's own tests use:

```ts
import { App, handleWebhook } from "@sabha-co/app-kit";
import { FakeSabha, messageEvent, signedDelivery } from "@sabha-co/app-kit/testing";

const sabha = new FakeSabha().app("sabha_app_test", { id: 99, name: "Helper" });
const app = new App({ fetch: sabha.fetch });
const env = { SABHA_BASE_URL: "https://sabha.test", SABHA_API_KEY: "sabha_app_test", SABHA_SIGNING_SECRET: "whsec_test" };

const response = await handleWebhook(app, await signedDelivery({ secret: env.SABHA_SIGNING_SECRET, payload: messageEvent() }), { env, waitUntil: () => {} });
```

- `signedDelivery` signs a payload as Sabha does.
- `FakeSabha` is the API as a `fetch`: it keeps messages, threads and drafts, honours client message ids, pages listings, and records every call in `calls`.
- `messageEvent`, `commandEvent`, `blockActionsEvent`, `reactionEvent` and `userEvent` build events with sensible defaults.

The [examples](examples), the standup among them, show tests for each kind of handler, including Workers tests with `@cloudflare/vitest-plugin`.

## The API

`client` covers every operation in Sabha's apps API, typed from its OpenAPI spec, and `client.call(method, path, options)` reaches anything newer. Each Sabha serves the spec at `/api/v1/openapi.json` and a guide written for agents at `/skill`.

Errors are `SabhaApiError` with `status`, `code` and, for a missing permission, `needed`. The client retries `429` (after `Retry-After`), `502`, `503`, `504` and network failures, up to three attempts.

## Security

See the standup's [security checklist](examples/standup/SECURITY.md). In short: the kit verifies every delivery and refuses one older than five minutes, and it keeps the key, the signing secret, `response_url`s and message text out of its logs and errors. Your handlers should do the same.

## This repo

| Path | What it is |
|---|---|
| `packages/app-kit` | The kit: the core, plus the `/cloudflare`, `/node` and `/testing` subpaths. |
| `examples` | One short, tested file per kind of handler. |
| `examples/standup` | The standup bot, ready to copy and deploy. |

```bash
pnpm install && pnpm typecheck && pnpm build && pnpm test
```

`pnpm --filter @sabha-co/app-kit gen:types <path to Sabha's v1.yaml>` refreshes the vendored spec and the generated types.
