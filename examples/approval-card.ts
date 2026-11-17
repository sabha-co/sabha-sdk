// An approval card: /deploy posts Approve and Reject buttons; only people listed in APPROVERS
// (comma-separated user ids) may press them, and the card then says who decided.
import { App, type SabhaEnv } from "@sabha-co/app-kit";

export const app = new App<SabhaEnv & { APPROVERS: string }>();

app.command("/deploy", ({ command }) => ({
  response_type: "in_channel",
  text: `Deploy ${command.text}?`,
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: `Deploy *${command.text}*?` } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "approve", style: "primary", value: command.text, text: { type: "plain_text", text: "Approve" } },
        { type: "button", action_id: "reject", style: "danger", value: command.text, text: { type: "plain_text", text: "Reject" } },
      ],
    },
  ],
}));

app.action(/^(approve|reject)$/, async ({ action, user, env, respond }) => {
  const approvers = env.APPROVERS.split(",").map((id) => id.trim());
  if (!approvers.includes(String(user.id))) {
    await respond({ response_type: "ephemeral", replace_original: false, text: "Only approvers can decide this deploy." });
    return;
  }
  const verdict = action.action_id === "approve" ? "Approved" : "Rejected";
  await respond({ replace_original: true, text: `${verdict} by ${user.name}: ${action.value}` });
});
