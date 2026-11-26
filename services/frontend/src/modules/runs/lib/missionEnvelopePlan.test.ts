import { describe, expect, it } from "vitest";

import { stripMissionEnvelopeFromPlan } from "./missionEnvelopePlan";

describe("stripMissionEnvelopeFromPlan", () => {
  it("removes the internal mission envelope section from plan markdown", () => {
    const plan = `# Mission Plan

## Phase 1

- Baseline the target.

## Mission Envelope
\`\`\`json
{
  "missions": [
    {
      "id": "task-1",
      "question": "What services are reachable?"
    }
  ]
}
\`\`\`
`;

    expect(stripMissionEnvelopeFromPlan(plan)).toBe(
      `# Mission Plan

## Phase 1

- Baseline the target.`,
    );
  });

  it("returns the original markdown when no mission envelope exists", () => {
    const plan = `# Mission Plan

- Enumerate the target.`;

    expect(stripMissionEnvelopeFromPlan(plan)).toBe(plan);
  });

  it("returns an empty string for missing plan content", () => {
    expect(stripMissionEnvelopeFromPlan(null)).toBe("");
    expect(stripMissionEnvelopeFromPlan(undefined)).toBe("");
    expect(stripMissionEnvelopeFromPlan("   ")).toBe("");
  });
});
