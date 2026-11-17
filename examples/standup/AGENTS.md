# AGENTS.md

This is the standup example for the Sabha SDK, a whole app to copy and deploy. The SDK's rules are in the SDK's `AGENTS.md`; these are the standup's own.

- The bot keeps no storage. It finds today's prompt by reading the room (`findPrompt`), and the replies by reading the thread (`readUpdates`). Don't add a KV, D1 or Durable Object store for them.
- Both schedules post with `stableId(runKey)` and use `retryFor: 10`. Keep both: together they make a missed tick recoverable and a repeated tick harmless.
- The digest never posts a prompt. If none went out today, it logs and stops.
- Quote member text with `inert` before it goes into the digest, so it can't mention anyone or turn into a link.
- Keep the permissions to `post` and `read_messages`. The suite fails if the bot calls anything else.
- New settings go in `StandupEnv`, `wrangler.jsonc` `vars` and the `cloudflare.bindings` descriptions in `package.json`; secrets go in `secrets.required`.
- `pnpm test` runs in workerd. Drive schedules with `createScheduledController` and the fake's `setNow`.
