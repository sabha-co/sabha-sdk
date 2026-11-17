// An approval card: /deploy posts Approve and Reject buttons; only people listed in APPROVERS
// (comma-separated user ids) may press them, and the card then says who decided.
import { App, type SabhaEnv } from "@sabha-co/sdk";

export const app = new App<SabhaEnv & { APPROVERS: string }>();

app.command("/deploy", ({ command }) => {
  // Only plain names: mrkdwn such as <branch|main> would show approvers one target and deploy another.
  const target = command.text.trim();
  if (!/^[\w./-]{1,100}$/.test(target)) return { response_type: "ephemeral", text: "Name a branch or tag: /deploy main" };
  const button = (action_id: string, label: string, style: string) => ({ type: "button", action_id, style, value: target, text: { type: "plain_text", text: label } });
  return {
    response_type: "in_channel",
    text: `Deploy ${target}?`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Deploy *${target}*?` } },
      { type: "actions", elements: [button("approve", "Approve", "primary"), button("reject", "Reject", "danger")] },
    ],
  };
});

app.action(/^(approve|reject)$/, async ({ action, user, env, respond }) => {
  const approvers = env.APPROVERS.split(",").map((id) => id.trim());
  if (!approvers.includes(String(user.id))) {
    await respond({ response_type: "ephemeral", replace_original: false, text: "Only approvers can decide this deploy." });
    return;
  }
  const verdict = action.action_id === "approve" ? "Approved" : "Rejected";
  await respond({ replace_original: true, text: `${verdict} by ${user.name}: ${action.value}` });
});
