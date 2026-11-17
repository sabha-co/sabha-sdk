import { describe, expect, expectTypeOf, it } from "vitest";
import { EventShapeError, eventKey, parseEvent, placeOf, type EventOf } from "./events.js";
import { blockActionsEvent, commandEvent, messageEvent, reactionEvent, userEvent } from "./testing/fixtures.js";

describe("events", () => {
  it("narrows a payload by event name", () => {
    const event = parseEvent(messageEvent());
    if (event.event === "message_created") {
      expectTypeOf(event.message.body.plain).toBeString();
      expectTypeOf(event.mentions_app).toEqualTypeOf<boolean | undefined>();
    }
    expectTypeOf<EventOf<"command">["response_url"]>().toBeString();
    expectTypeOf<EventOf<"reaction_created">["reaction"]["body"]>().toBeString();
    // @ts-expect-error a command has no room object
    expectTypeOf<EventOf<"command">["room"]>();
  });

  it("reads mentions_app at the top level and the place from room.type", () => {
    const event = messageEvent({ room: { ...messageEvent().room, type: "Thread" } });
    expect(event.mentions_app).toBe(true);
    expect(placeOf(event.room)).toBe("thread");
    expect(placeOf({ type: "Direct" })).toBe("dm");
    expect(placeOf({ type: "Post" })).toBe("post");
    expect(placeOf({ type: "Closed" })).toBe("room");
  });

  it("keys each event by what it's about", () => {
    expect(eventKey(messageEvent())).toBe("message:501");
    expect(eventKey(messageEvent({ event: "message_updated" }))).toBe("edit:501:2026-11-16T09:00:00Z");
    expect(eventKey(reactionEvent())).toBe("react:77");
    expect(eventKey(commandEvent())).toBe("command:cmd-1");
    expect(eventKey(blockActionsEvent())).toBe("action:act-1");
    expect(eventKey(userEvent())).toBe("user_created:7");
  });

  it("refuses payloads missing what the kit relies on, and passes unknown events through", () => {
    expect(() => parseEvent({ event: "message_created", room: { id: 1 } })).toThrow(EventShapeError);
    expect(() => parseEvent({ event: "command", id: "x" })).toThrow(EventShapeError);
    expect(() => parseEvent("nope")).toThrow(EventShapeError);
    expect(parseEvent({ event: "room_archived", room: { id: 1 } })).toMatchObject({ event: "room_archived" });
  });
});
