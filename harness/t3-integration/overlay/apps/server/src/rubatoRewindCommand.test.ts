import { describe, expect, it } from "@effect/vitest";

import { rewindCommandTarget } from "./rubatoRewindCommand.ts";

describe("/rewind", () => {
  const checkpoints = [
    { turnId: "t1", checkpointTurnCount: 1 },
    { turnId: "t2", checkpointTurnCount: 2 },
    { turnId: "t3", checkpointTurnCount: 3 },
    { turnId: "command", checkpointTurnCount: 4 },
  ];

  it("drops the asked turns before the command, and the command's own turn", () => {
    expect(rewindCommandTarget(checkpoints, "command", 1)).toBe(2);
    expect(rewindCommandTarget(checkpoints, "command", 3)).toBe(0);
  });

  it("waits for the command's turn to be numbered, and refuses more turns than there are", () => {
    expect(rewindCommandTarget(checkpoints.slice(0, 3), "command", 1)).toBeUndefined();
    expect(rewindCommandTarget(checkpoints, "command", 4)).toBe(
      "This conversation has only 3 turns to rewind.",
    );
  });
});
