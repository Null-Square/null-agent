import { describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "./runStatus";

describe("isTerminalRunStatus", () => {
  it.each(["completed", "failed", "cancelled"])(
    "treats %s as terminal",
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(true);
    },
  );

  it.each([undefined, null, "queued", "running", "paused"])(
    "keeps %s live",
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(false);
    },
  );
});
