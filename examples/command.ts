// A slash command. Return within 3 seconds and the answer goes straight back to the member;
// take longer and the kit sends it to the command's response_url instead.
import { App } from "@sabha-co/app-kit";

export const app = new App();

app.command("/ticket", async ({ command, user }) => {
  const title = command.text.trim();
  if (!title) return { response_type: "ephemeral", text: "Usage: /ticket <what's wrong>" };
  const id = await fileTicket(title);
  return { response_type: "in_channel", text: `${user.name} filed #${id}: ${title}` };
});

// Stands in for your tracker's API.
async function fileTicket(title: string): Promise<number> {
  return 1000 + title.length;
}
