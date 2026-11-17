import type { App, Answer } from "./app.js";
import { secretsOf } from "./app.js";
import type { Runtime, SabhaEnv } from "./context.js";
import { ConfigError } from "./errors.js";
import { EventShapeError, parseEvent } from "./events.js";
import { describeError } from "./log.js";
import { verify } from "./verify.js";

export interface WebhookOptions<Env extends SabhaEnv> {
  env: Env;
  /** Keeps work running after the response; a Worker passes `ctx.waitUntil`. */
  waitUntil(promise: Promise<unknown>): void;
  /** For tests: the time to check the timestamp against, in milliseconds. */
  now?: number;
}

/** Sabha never waits longer than this, so a larger header (it isn't signed) is ignored. */
const MAX_WAIT_SECONDS = 300;

/** How long Sabha waits for this delivery's answer, from its X-Sabha-Timeout header. */
function waitOf(request: Request): number | undefined {
  const value = request.headers.get("X-Sabha-Timeout");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Math.min(Number(value), MAX_WAIT_SECONDS) * 1000;
}

const text = (status: number, body = "") => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/**
 * Answers one webhook delivery from Sabha. A delivery that fails the signature or timestamp
 * check is 401 and runs nothing. A verified one is always answered 2xx, unless a handler asks
 * for a retry Sabha will make, because five failed events in a row suspend the webhook.
 */
export async function handleWebhook<Env extends SabhaEnv>(app: App<Env>, request: Request, options: WebhookOptions<Env>): Promise<Response> {
  const { env } = options;
  const receivedAt = Date.now();
  if (!env.SABHA_SIGNING_SECRET) {
    app.logger.error("SABHA_SIGNING_SECRET isn't set, so no delivery can be checked");
    return text(500, "The app's signing secret isn't set.");
  }

  const body = await request.text();
  const verdict = await verify(
    env.SABHA_SIGNING_SECRET,
    { timestamp: request.headers.get("X-Sabha-Timestamp"), signature: request.headers.get("X-Sabha-Signature") },
    body,
    options.now,
  );
  if (!verdict.ok) {
    app.logger.warn("refused a delivery", { reason: verdict.reason });
    return text(401);
  }

  // Sabha sends every event to the socket too, and in socket mode the socket handles it.
  if (env.TRANSPORT === "socket") return text(200);

  let event;
  try {
    event = parseEvent(JSON.parse(body));
  } catch (error) {
    app.logger.error("a verified delivery couldn't be read", { error: error instanceof EventShapeError ? error.message : "not JSON" });
    return text(200);
  }

  let runtime: Runtime<Env>;
  try {
    runtime = { env, client: app.clientFor(env), logger: app.logger, transport: "webhook", waitUntil: (promise) => options.waitUntil(promise) };
  } catch (error) {
    app.logger.error("the app's settings are incomplete", { error: describeError(error, secretsOf(env)) });
    return text(error instanceof ConfigError ? 500 : 200);
  }

  const wait = waitOf(request);
  const answer = await app.dispatch(event, runtime, { inline: true, ...(wait === undefined ? {} : { answerBy: receivedAt + wait }) });
  return toResponse(answer);
}

function toResponse(answer: Answer | undefined): Response {
  if (!answer) return text(200);
  if (answer.status === 503) return text(503);
  if ("json" in answer) return Response.json(answer.json, { status: 200 });
  return text(200, answer.text);
}
