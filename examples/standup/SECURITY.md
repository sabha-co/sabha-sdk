# Security checklist

For the standup, and any app built on the SDK.

- **Verify every delivery.** `createWorker` and `handleWebhook` check the signature and refuse anything older than five minutes. Don't add a route that runs a handler without them.
- **Keep the key and signing secret secret.** Store them with `wrangler secret put` (or `.dev.vars` locally, which is ignored by git), never in `wrangler.jsonc` or code. Rotate them on the app's page if they leak.
- **Keep secrets and private text out of logs.** Workers logs are readable by everyone on the Cloudflare account. Log ids, statuses and error codes; never the key, the secret, a `response_url` (it can post without a key), or message text. The SDK scrubs the key and secret from the errors it logs; the fields you log are written as given.
- **Ask only for the permissions you use.** The standup needs `post` and `read_messages`, nothing else.
- **Treat what members send as untrusted.** Message text, a command's `text` and an action's `value` come from people. Don't build HTML, SQL or shell commands from them, and quote them before reposting: the digest breaks mentions and links in replies so a reply can't make the bot notify anyone.
- **Check who acted before anything privileged.** A button press or a command comes from whoever pressed it. Compare `user.id` against an allowlist (as `examples/approval-card.ts` does) before deploying, paying or deleting.
- **Make external effects happen once.** The SDK drops a repeated event, but only while an isolate lives. Key effects outside Sabha on `ctx.eventKey` in your own store.
- **Use a separate app for development,** so a local socket never takes the production app's events.
