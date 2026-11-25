# Porting from Bolt

The SDK is shaped like Slack's [Bolt](https://tools.slack.dev/bolt-js/): an `App`, listeners by kind, a context with `say` and `respond`. Porting is a rewrite of each listener's first few lines, not of its logic. Sabha's API takes Slack's message shapes (mrkdwn `text`, Block Kit `blocks`, `response_url` envelopes), so what a listener posts mostly carries over.

## Setup

| Bolt | The SDK |
|---|---|
| `new App({ token, signingSecret })` | `new App()`, with `SABHA_API_KEY` and `SABHA_SIGNING_SECRET` in the environment |
| `socketMode: true, appToken` | `TRANSPORT=socket`; the same key, no second token |
| `await app.start(3000)` | `export default createWorker(app)` on Cloudflare, or `runSocket(app, { env })` on Node |
| `ExpressReceiver`, custom receivers | `handleWebhook(app, request, { env, waitUntil })` with a Web `Request` |
| `app.error(handler)` | Handler errors are logged; catch inside the handler to answer the member |

## Listeners

| Bolt | The SDK |
|---|---|
| `app.event("app_mention", …)` | `app.mention(…)` |
| `app.message("hello", …)` | `app.message(…)`, testing `message.body.plain` yourself |
| `app.message(…)` in DMs only (`channel_type: "im"`) | `app.message({ in: "dm" }, …)` |
| `app.command("/x", …)` | `app.command("/x", …)` |
| `app.action("id", …)`, `app.action(/re/, …)` | `app.action("id", …)`, `app.action(/re/, …)` |
| `app.event("reaction_added", …)` | `app.reaction(…)`, or `app.reaction({ emoji: "👀" }, …)` |
| `app.event("message", …)` with `subtype: "message_changed"` | `app.event("message_updated", …)` |
| `app.view(…)`, `app.shortcut(…)`, `app.options(…)` | None: Sabha has no modals, shortcuts or external selects |
| Global middleware | None: share a function between handlers |

## Inside a listener

| Bolt | The SDK |
|---|---|
| `await ack()` | Nothing. Returning is the acknowledgement. |
| `await ack({ text })` in a command | `return { text }` within 3 s. Later, the SDK sends it to `response_url`. |
| `await say("hi")` | `await say("hi")`, or `return "hi"` |
| `await say({ text, thread_ts: message.ts })` | `await say({ text, thread: true })` |
| `await respond({ replace_original: true, … })` | `await respond({ replace_original: true, … })` |
| `body.user.id`, `command.user_id` | `user.id`, `user.name` |
| `body.channel.id`, `command.channel_id` | `channel.id` for messages, `command.channel_id`, `event.channel.id` for clicks |
| `message.ts` | `message.id` |
| `client.chat.postMessage({ channel, text })` | `client.post(channelId, { text })` |
| `client.chat.update({ channel, ts, text })` | `client.editMessage(messageId, { body })` |
| `client.conversations.replies({ channel, ts })` | `client.allMessages(message.replies.channel_id)`: a thread is its own channel |
| `client.reactions.add({ name: "eyes", … })` | `client.react(messageId, "👀")`, with the emoji itself |
| `chat.startStream` / `appendStream` / `stopStream` | `const d = await draft()`, `d.update({ text })` with the whole text, `d.finish(text)` |
| `assistant.threads.setStatus` | `status("Thinking…")` |

## What's different

- **Mentions** are written `<@42>` in `text`, with Sabha's numeric user id.
- **Retries.** Slack retries most events; Sabha never retries `message_created`, `reaction_created` or `command`. See [Retrying](../README.md#retrying).
- **Idempotency.** Every `say` and `return` carries a client message id, so a redelivery never posts twice. Do the same for your own posts with `stableId(key)`.
- **Permissions** replace scopes: `post` for `chat:write`, `reactions:write` and `commands`; `read_messages` for the `*:history` scopes; `read_directory` for `users:read` and `channels:read`.
- **Errors** are `SabhaApiError` with an HTTP `status` and a `code`, not `{ ok: false }` on a `200`.

Sabha's apps guide, served at `/skill` on every Sabha, has the full method, scope and event mapping.
