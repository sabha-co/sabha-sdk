// An agent that streams: a status while it thinks, then a draft that fills in as the answer
// arrives, then the finished reply in the draft's place. Drafts notify no one; the finished
// post notifies once.
import { App } from "@sabha-co/sdk";

export const app = new App();

app.mention(async ({ message, status, draft }) => {
  await status("Thinking…", { thread: true });
  const reply = await draft({ thread: true });
  let text = "";
  for await (const chunk of answer(message.body.plain)) {
    text += chunk;
    await reply.update({ text }); // the whole text so far, every time
  }
  await reply.finish(text);
});

// Stands in for your model's streaming API.
async function* answer(_question: string): AsyncGenerator<string> {
  for (const word of ["Here's", " what", " I", " found."]) yield word;
}
