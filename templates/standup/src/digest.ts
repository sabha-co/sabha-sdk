// The digest: today's prompt, the replies in its thread, and the text that sums them up. Every
// reply is quoted so it can't notify anyone or turn into a link when the bot posts it.
import { SabhaApiError, type Message, type SabhaClient } from "@sabha-co/app-kit";

export interface Update {
  name: string;
  replies: string[];
}

/**
 * Today's prompt: the app's own message in the room posted at or after `since`. Read, never
 * posted, so a prompt that didn't go out is never sent late. The earliest match wins, since a
 * digest from an earlier tick is newer than the prompt.
 */
export async function findPrompt(client: SabhaClient, roomId: number, appId: number, since: number): Promise<Message | undefined> {
  let prompt: Message | undefined;
  for await (const message of client.allMessages(roomId)) {
    if (Date.parse(message.created_at) < since) break;
    if (message.creator.id === appId && !message.thread) prompt = message;
  }
  return prompt;
}

/** Each person's replies in the thread, in the order they first replied, leaving out the app's own. */
export async function readUpdates(client: SabhaClient, threadRoomId: number, appId: number): Promise<Update[]> {
  const replies: Message[] = [];
  try {
    for await (const message of client.allMessages(threadRoomId)) replies.push(message);
  } catch (error) {
    if (error instanceof SabhaApiError && error.status === 404) return [];
    throw error;
  }
  const updates = new Map<number, Update>();
  for (const reply of replies.reverse()) {
    if (reply.creator.id === appId) continue;
    const text = reply.body.plain.trim();
    if (!text) continue;
    const update = updates.get(reply.creator.id) ?? { name: reply.creator.name, replies: [] };
    update.replies.push(text);
    updates.set(reply.creator.id, update);
  }
  return [...updates.values()];
}

const ZERO_WIDTH_SPACE = "​";

/**
 * Text that renders as written but can't act: no mention (`@{id}`), no link (a scheme, `www.`
 * or an email address), no markup. A zero-width space breaks each pattern Sabha looks for.
 */
export function inert(text: string): string {
  const broken = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:(?=\/\/)/g, `${ZERO_WIDTH_SPACE}:`)
    .replace(/(www)\./gi, `$1${ZERO_WIDTH_SPACE}.`)
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
  return escapeHtml(broken);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** `2026-11-16` as "Monday 16 November". */
export function dayName(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
}

/** The digest as HTML: a heading linking the thread, then one line per person. */
export function digestHtml(updates: Update[], options: { localDate: string; threadUrl: string }): string {
  const heading = `<p><strong>Standup, ${escapeHtml(dayName(options.localDate))}</strong> · <a href="${escapeHtml(options.threadUrl)}">Read the thread</a></p>`;
  if (updates.length === 0) return `${heading}<p>No one posted an update today.</p>`;
  const lines = updates.map((update) => `<strong>${inert(update.name)}</strong>: ${update.replies.map((reply) => `“${inert(reply)}”`).join(" ")}`);
  return `${heading}<p>${lines.join("<br>")}</p>`;
}
