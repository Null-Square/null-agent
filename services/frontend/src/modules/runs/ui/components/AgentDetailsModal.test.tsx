import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type {
  ParentHierarchyNode,
  WorkerHierarchyNode,
} from "@/modules/runs/lib/agentHierarchy";
import AgentDetailsModal from "./AgentDetailsModal";

const mockAgentResponseFeed = vi.fn();

vi.mock("./AgentResponseFeed", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockAgentResponseFeed(props);
    return <div data-testid="agent-response-feed" />;
  },
}));

const parentNode: ParentHierarchyNode = {
  id: "parent:session-root",
  label: "Assessment parent",
  status: "running",
  statusLabel: "running",
  tone: "running",
  coordination: { role: "direct" },
  waitingOnDependency: true,
};

const workerNode: WorkerHierarchyNode = {
  id: "worker:task-1",
  taskId: "task-1",
  workerSessionId: "worker-session-1",
  workerType: "recon_worker",
  label: "Recon Worker",
  task: "Map the public surface area.",
  reason: "Need a bounded recon pass.",
  status: "running",
  statusLabel: "running · Dependency",
  tone: "running",
  executionMode: "blocking",
  dependencyMode: "dependency",
  createdAt: Date.now(),
  inheritedConstraint: null,
  raw: {
    taskId: "task-1",
    parentSessionId: "session-root",
    workerSessionId: "worker-session-1",
    workerType: "recon_worker",
    status: "running",
    reason: "Need a bounded recon pass.",
    task: "Map the public surface area.",
    expectedArtifactType: "surface_map",
    executionMode: "background",
    dependencyMode: "dependency",
    continuationMode: "spawn",
    createdAt: Date.now(),
  },
};

describe("AgentDetailsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the parent session id through to the response feed for parent nodes", async () => {
    render(
      <AgentDetailsModal
        isOpen
        onClose={() => undefined}
        node={parentNode}
        sessionId="session-root"
      />,
    );

    await screen.findByTestId("agent-response-feed");

    await waitFor(() => {
      expect(mockAgentResponseFeed).toHaveBeenCalled();
    });
    expect(mockAgentResponseFeed.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionId: "session-root",
        className: "h-full",
      }),
    );
    expect(screen.getByText("session-root")).toBeInTheDocument();
    expect(screen.getByText(/waiting on dependency/i)).toBeInTheDocument();
  });

  it("passes the worker session id through to the response feed for worker nodes", async () => {
    render(
      <AgentDetailsModal
        isOpen
        onClose={() => undefined}
        node={workerNode}
        sessionId="worker-session-1"
      />,
    );

    await screen.findByTestId("agent-response-feed");

    await waitFor(() => {
      expect(mockAgentResponseFeed).toHaveBeenCalled();
    });
    expect(mockAgentResponseFeed.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionId: "worker-session-1",
        className: "h-full",
      }),
    );
    expect(screen.getByText("Dependency")).toBeInTheDocument();
  });

  it("stops response polling when either the run or selected agent is terminal", async () => {
    const completedWorker = {
      ...workerNode,
      status: "completed",
      statusLabel: "completed",
    } as WorkerHierarchyNode;

    render(
      <AgentDetailsModal
        isOpen
        onClose={() => undefined}
        node={completedWorker}
        sessionId="worker-session-1"
        runStatus="running"
      />,
    );

    await screen.findByTestId("agent-response-feed");
    expect(mockAgentResponseFeed.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ isTerminal: true }),
    );
  });

  it("renders enumeration mission, budget, result, capability, and disposition details", async () => {
    const enumerationNode = {
      ...workerNode,
      workerType: "enumeration_worker",
      label: "Enumeration Worker",
      raw: {
        ...workerNode.raw,
        workerType: "enumeration_worker",
        planStepId: "enum-step-1",
        targetRequestsUsed: 3,
        deadlineAt: Date.now() + 60_000,
        budget: { maxTargetRequests: 40, maxRequestConcurrency: 2, maxWallSeconds: 360 },
        enumerationCapability: {
          enabled: true,
          cohort: "allowlist",
          policyVersion: 1,
          catalogVersion: "3.0.0-b1",
        },
        mission: {
          question: "Does authorization drift?",
          whyReadyNow: "Endpoint known",
          requiredEvidence: ["request diff"],
          expectedArtifact: "enumeration_result/v1",
          stopCondition: "bounded",
          enumeration: {
            targetRef: "https://app.example.com",
            surface: { kind: "endpoint_set", refs: ["/api/users/{id}"] },
            primarySkill: { slug: "idor", versionHash: "a".repeat(64) },
            supportingSkills: [],
          },
        },
        artifact: {
          taskId: "task-1",
          workerType: "enumeration_worker",
          summary: "bounded result",
          findings: [],
          evidenceRefs: [],
          touchedTargets: [],
          enumeration: {
            schemaVersion: 1,
            status: "completed",
            leads: [],
            negativeResults: [],
            blockers: [],
            artifacts: [],
            coverage: {
              counts: { attempts: 2, requests: 3 },
              uncovered: [],
            },
          },
        },
        enumerationDisposition: {
          action: "disposition",
          leadDispositions: [],
          canonicalLeadIds: ["lead-1"],
        },
      },
    } as unknown as WorkerHierarchyNode;

    render(
      <AgentDetailsModal
        isOpen
        onClose={() => undefined}
        node={enumerationNode}
        sessionId="worker-session-1"
      />,
    );

    expect(await screen.findByText("Enumeration contract")).toBeInTheDocument();
    expect(screen.getByText("enum-step-1")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/app\.example\.com/u)).toBeInTheDocument();
    expect(screen.getByText(/3\/40 requests/u)).toBeInTheDocument();
    expect(screen.getByText(/allowlist · policy 1 · 3\.0\.0-b1/u)).toBeInTheDocument();
    expect(screen.getByText(/Canonical leads: lead-1/u)).toBeInTheDocument();
  });

  it("renders controlled exploitation mission, result, cleanup, and parent disposition details", async () => {
    const attackNode = {
      ...workerNode,
      workerType: "attack_worker",
      label: "Attack Worker",
      status: "completed",
      statusLabel: "completed",
      raw: {
        ...workerNode.raw,
        workerType: "attack_worker",
        status: "completed",
        planStepId: "attack-step-1",
        targetRequestsUsed: 4,
        mission: {
          phase: "exploitation",
          question: "Can command injection impact be demonstrated?",
          whyReadyNow: "Validation confirmed command injection.",
          requiredEvidence: ["impact proof", "cleanup proof"],
          expectedArtifact: "attack_result/v1",
          stopCondition: "Stop after cleanup.",
          attack: {
            schemaVersion: 1,
            kind: "controlled_exploitation_v1",
            objectiveFamily: "demonstrate_command_execution",
            objective: "Create and remove a bounded marker file.",
            validatedFindingIds: ["finding-1"],
            targetRef: "https://xben.example.test/vulnerable?cmd=marker",
            allowedImpact: ["create_marker"],
            requestBudget: 8,
            toolBudget: 5,
            timeBudgetSeconds: 120,
            maxRequestConcurrency: 1,
            requiredProof: ["marker output"],
            stopConditions: ["cleanup complete"],
            cleanupPlan: ["delete marker"],
          },
        },
        artifact: {
          taskId: "task-1",
          workerType: "attack_worker",
          summary: "Impact demonstrated but cleanup needs operator attention.",
          findings: [],
          evidenceRefs: ["impact:http-proof"],
          touchedTargets: ["https://xben.example.test/vulnerable?cmd=marker"],
          attack: {
            schemaVersion: 1,
            missionId: "task-1",
            validatedFindingIds: ["finding-1"],
            targetRef: "https://xben.example.test/vulnerable?cmd=marker",
            objectiveFamily: "demonstrate_command_execution",
            status: "cleanup_failed",
            attempts: [
              {
                sequence: 1,
                action: "write bounded marker and read command output",
                status: "completed",
                evidenceIds: ["impact:http-proof"],
                changedState: true,
              },
            ],
            proofClaim: "Command execution created and returned marker NULLAI-B8.",
            evidenceIds: ["impact:http-proof"],
            changedStateSummary: "Created marker file NULLAI-B8 in the isolated target.",
            cleanup: {
              required: true,
              status: "failed",
              actions: ["attempted marker deletion"],
              evidenceIds: ["cleanup:delete-attempt"],
              remainingRisk: "Marker deletion endpoint returned 500.",
            },
            limitations: ["Target was isolated to the evaluation container."],
            policySnapshot: { live: true },
          },
        },
        attackDisposition: {
          action: "disposition",
          resultStatus: "cleanup_failed",
          evidenceIds: ["impact:http-proof", "cleanup:delete-attempt"],
          terminalReason: "Cleanup failed and remaining risk was surfaced.",
          completedAt: Date.now(),
        },
      },
    } as unknown as WorkerHierarchyNode;

    render(
      <AgentDetailsModal
        isOpen
        onClose={() => undefined}
        node={attackNode}
        sessionId="worker-session-1"
      />,
    );

    expect(await screen.findByText("Controlled exploitation contract")).toBeInTheDocument();
    expect(
      screen.getByText("demonstrate_command_execution: Create and remove a bounded marker file."),
    ).toBeInTheDocument();
    expect(screen.getByText("finding-1")).toBeInTheDocument();
    expect(screen.getAllByText(/https:\/\/xben\.example\.test\/vulnerable/u).length).toBeGreaterThan(0);
    expect(screen.getByText(/4\/8 requests \/ 5 tools \/ 120s \/ 1 concurrent/u)).toBeInTheDocument();
    expect(screen.getByText("Command execution created and returned marker NULLAI-B8.")).toBeInTheDocument();
    expect(screen.getByText("failed - Marker deletion endpoint returned 500.")).toBeInTheDocument();
    expect(screen.getByText("Cleanup evidence: cleanup:delete-attempt")).toBeInTheDocument();
    expect(screen.getByText("disposition / cleanup_failed")).toBeInTheDocument();
    expect(screen.getByText("Cleanup failed and remaining risk was surfaced.")).toBeInTheDocument();
  });
});
