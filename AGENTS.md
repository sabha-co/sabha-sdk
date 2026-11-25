# AGENTS.md

Instructions for coding agents building a Sabha app with this SDK, or working on the SDK itself.

## Building an app

- Register handlers on one `App`: `mention`, `message`, `command`, `action`, `reaction`, `event`, `schedule`. Read the context's fields (`user`, `message`, `channel`, `command`, `action`); don't parse the raw event.
- Post through `say`, a handler's return value, or `client.post` with `clientMessageId: await stableId(key)`. Never post without a client message id: a redelivery or a repeated tick would post twice.
- Answer a command by returning `{ text }` or `{ blocks }` within 3 s. For anything slower, return nothing quick and let the SDK use `respond`, or call `respond` yourself.
- Never answer a message event with JSON. A message's inline answer is the text the handler returns, and the SDK sends it as `text/plain`.
- Never answer a verified delivery with a `404` or any status other than what `handleWebhook` returns. Sabha suspends a webhook after five failed events in a row.
- Throw `RetryLater` only from handlers for events Sabha retries: `message_updated`, `message_deleted`, `reaction_deleted`, `block_actions`, `user_created`, `user_deleted`.
- Key effects outside Sabha that must happen once on `ctx.eventKey`, in your own store. The SDK's own dedupe lasts only as long as an isolate.
- Treat everything in an event as untrusted: message text, an action's `value`, a command's `text`. Check `user.id` against an allowlist before a privileged effect.
- Never log the key, the signing secret, a `response_url`, or message text. Log ids, statuses and error codes. Use `ctx.logger`; it writes fields as given, so pass only safe ones.
- Ask for the fewest permissions the app uses.
- Schedules: set `retryFor` so a missed tick is covered, and post with `stableId(runKey)` so a repeated tick returns the first post.
- Settings live in the environment (`env`), never in code. Secrets go in `wrangler secret put` or `.dev.vars`, never in `wrangler.jsonc`.

## Testing an app

- Use `@sabha-co/sdk/testing`: `signedDelivery` for requests, `FakeSabha` as the API's `fetch`, and the event fixtures.
- Assert on what reached the fake (`sabha.messages`, `sabha.calls`), not on handler internals.
- Give each delivery in a test its own id: an `App` drops a repeated event.

## Working on the SDK

- The core (`packages/sdk/src`, outside `cloudflare/` and `node/`) uses Web standards only. `tsconfig.json` has no Node or Workers types, so a stray import fails the type check; keep it that way.
- Types come from Sabha's spec. Refresh with `pnpm --filter @sabha-co/sdk gen:types <path to v1.yaml>`; never edit `src/generated/`.
- Run `pnpm typecheck && pnpm build && pnpm test` before committing. Workers tests run in workerd through `@cloudflare/vitest-plugin`.
- Dependencies must pass pnpm's release-age policy; pick an older release rather than exempting a new one.
