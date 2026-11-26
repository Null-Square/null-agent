import { describe, expect, it } from "vitest";
import { buildAgentHierarchyModel } from "./agentHierarchy";

describe("agentHierarchy", () => {
  it("marks the parent as waiting when an active dependency worker exists", () => {
    const model = buildAgentHierarchyModel(
      {
        id: "run-1",
        title: "Catalog scout",
        status: "running",
        pauseReason: null,
      } as any,
      {
        id: "session-1",
        coordination: { role: "direct" },
        workerTasks: [
          {
            taskId: "task-dependency",
            parentSessionId: "session-1",
            workerSessionId: "worker-1",
            workerType: "recon_worker",
            status: "running",
            reason: "Need initial surface map before validation.",
            task: "Map the primary public surface.",
            expectedArtifactType: "surface_map",
            executionMode: "blocking",
            dependencyMode: "dependency",
            continuationMode: "spawn",
            createdAt: 1,
          },
          {
            taskId: "task-sidecar",
            parentSessionId: "session-1",
            workerSessionId: "worker-2",
            workerType: "validator_worker",
            status: "running",
            reason: "Parallel authorization diff.",
            task: "Diff denial responses on the jobs edge.",
            expectedArtifactType: "authorization_diff",
            executionMode: "background",
            dependencyMode: "sidecar",
            continuationMode: "continue",
            createdAt: 2,
          },
        ],
      } as any,
    );

    expect(model.parent.waitingOnDependency).toBe(true);
    expect(model.workers[0]).toMatchObject({
      dependencyMode: "dependency",
      executionMode: "blocking",
      statusLabel: expect.stringContaining("Dependency"),
    });
    expect(model.workers[1]).toMatchObject({
      dependencyMode: "sidecar",
      executionMode: "background",
      statusLabel: expect.stringContaining("Sidecar"),
    });
  });
});
