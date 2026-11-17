// Answers a mention. Over a webhook Sabha posts the returned text as the app's reply; over
// the socket the SDK posts it. Run either way:
//   Cloudflare: export default createWorker(app)      Node: runSocket(app, { env })
import { App } from "@sabha-co/sdk";

export const app = new App();

app.mention(({ user }) => `Hi ${user.name}! Ask me in a thread and I'll answer there.`);

// In a thread, say() posts beside the message instead; a redelivery never posts twice.
app.message({ in: "thread" }, async ({ message, say }) => {
  if (message.body.plain.trim().toLowerCase() === "ping") await say("pong");
});
