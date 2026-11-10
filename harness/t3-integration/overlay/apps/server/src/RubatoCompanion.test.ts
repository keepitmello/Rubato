// The companion's room thread (RubatoCompanion.ts companionRoom): the room cannot open an archived
// thread, so the lookup for the current conversation takes it out of the archive.
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { companionRoom } from "./RubatoCompanion.ts";

class Refused extends Data.TaggedError("Refused") {}

const recorder = (archived: boolean, fails = false) => {
  const unarchived: string[] = [];
  return {
    unarchived,
    io: {
      archived: () => Effect.succeed(archived),
      unarchive: (threadId: string) =>
        fails ? Effect.fail(new Refused()) : Effect.sync(() => void unarchived.push(threadId)),
    },
  };
};

describe("companion room", () => {
  it.effect("takes an archived room thread out of the archive", () =>
    Effect.gen(function* () {
      const room = recorder(true);
      expect(yield* companionRoom("roo-thread", room.io)).toBe("roo-thread");
      expect(room.unarchived).toEqual(["roo-thread"]);
    }));

  it.effect("leaves a thread that is not archived alone", () =>
    Effect.gen(function* () {
      const room = recorder(false);
      expect(yield* companionRoom("segno-thread", room.io)).toBe("segno-thread");
      expect(room.unarchived).toEqual([]);
    }));

  it.effect("answers the thread when the unarchive fails, and nothing before the app picks it up", () =>
    Effect.gen(function* () {
      expect(yield* companionRoom("roo-thread", recorder(true, true).io)).toBe("roo-thread");
      const room = recorder(true);
      expect(yield* companionRoom(null, room.io)).toBeNull();
      expect(room.unarchived).toEqual([]);
    }));
});
