import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
// The component moved to the kit; the test stays here because the kit has no
// vitest project of its own and a test that does not run is worse than a test
// filed in the wrong directory.
import { RunStatusBadge } from "@null-ai/design-tokens/ui";

describe("RunStatusBadge", () => {
  it("labels recoverable system pauses clearly", () => {
    render(<RunStatusBadge status="paused" pauseReason="system" interactionType="none" />);

    expect(screen.getByText("Recoverable Pause")).toBeInTheDocument();
  });
});
