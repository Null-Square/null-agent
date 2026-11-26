import type { Run, RunPauseReason, RunStatus } from "@/modules/security-ops/types";
import type {
  ChatSessionSnapshot,
  SessionCoordination,
  WorkerResultArtifact,
  WorkerTaskRecord,
} from "@/types/chat";

export type AgentDisplayTone =
  | "neutral"
  | "running"
  | "waiting"
  | "success"
  | "danger"
  | "blocked"
  | "terminal";

export interface InheritedAgentConstraint {
  label: string;
  detail: string;
  tone: "blocked" | "terminal";
}

export interface WorkerHierarchyNode {
  id: string;
  taskId: string;
  workerSessionId: string;
  workerType: WorkerTaskRecord["workerType"];
  label: string;
  task: string;
  reason: string;
  status: WorkerTaskRecord["status"];
  statusLabel: string;
  tone: AgentDisplayTone;
  executionMode: WorkerTaskRecord["executionMode"];
  dependencyMode: NonNullable<WorkerTaskRecord["dependencyMode"]>;
  summary?: string;
  lastStatusReason?: string;
  artifact?: WorkerResultArtifact;
  createdAt: number;
  inheritedConstraint: InheritedAgentConstraint | null;
  raw: WorkerTaskRecord;
}

export interface ParentHierarchyNode {
  id: string;
  label: string;
  status: RunStatus | "idle";
  statusLabel: string;
  tone: AgentDisplayTone;
  coordination: SessionCoordination | null;
  waitingOnDependency: boolean;
}

export interface AgentHierarchyModel {
  parent: ParentHierarchyNode;
  workers: WorkerHierarchyNode[];
}

const BLOCKING_PARENT_STATUSES = new Set<RunStatus>([
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const hasAgentTopology = (
  session?: Pick<ChatSessionSnapshot, "coordination" | "workerTasks" | "workerResult"> | null,
): boolean =>
  Boolean(
    session?.coordination ||
      (session?.workerTasks && session.workerTasks.length > 0) ||
      session?.workerResult,
  );

export function humanizeWorkerType(workerType: WorkerTaskRecord["workerType"]): string {
  const normalized =
    workerType === "exploit_worker"
      ? "validator_worker"
      : workerType === "report_writer_worker"
        ? "evidence_worker"
        : workerType;
  return normalized
    .replace(/_worker$/u, "")
    .replace(/_/gu, " ")
    .replace(/\b\w/gu, (char) => char.toUpperCase());
}

export function formatWorkerStatus(status: WorkerTaskRecord["status"]): string {
  return status.replace(/_/gu, " ");
}

export function formatDependencyMode(
  dependencyMode?: WorkerTaskRecord["dependencyMode"],
): string {
  return dependencyMode === "dependency" ? "Dependency" : "Sidecar";
}

export function describeCoordinationRole(
  coordination?: SessionCoordination | null,
): string {
  if (!coordination || coordination.role === "direct") {
    return "Direct session";
  }
  if (coordination.role === "worker") {
    return "Bounded worker";
  }
  return "Parent executor";
}

export function getWorkerTone(status: WorkerTaskRecord["status"]): AgentDisplayTone {
  switch (status) {
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    case "awaiting_approval":
    case "awaiting_input":
      return "waiting";
    case "completed":
      return "success";
    case "failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

export function getParentTone(status?: string | null): AgentDisplayTone {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "blocked";
    case "completed":
      return "terminal";
    case "failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

export function describeParentConstraint(
  status?: string | null,
  pauseReason?: RunPauseReason | null,
): InheritedAgentConstraint | null {
  if (!status || !BLOCKING_PARENT_STATUSES.has(status as RunStatus)) {
    return null;
  }

  if (status === "paused") {
    if (pauseReason === "credits") {
      return {
        label: "Parent blocked",
        detail: "Parent session is out of credits. Worker execution is visually treated as blocked.",
        tone: "blocked",
      };
    }
    return {
      label: "Parent paused",
      detail: "Parent session is paused. Worker execution is visually treated as blocked until the parent resumes.",
      tone: "blocked",
    };
  }

  if (status === "completed") {
    return {
      label: "Parent completed",
      detail: "Parent session already completed. Worker rows are shown as terminal even if child snapshots lag.",
      tone: "terminal",
    };
  }

  if (status === "failed") {
    return {
      label: "Parent failed",
      detail: "Parent session failed. Worker rows are shown as terminal even if child snapshots lag.",
      tone: "terminal",
    };
  }

  return {
    label: "Parent cancelled",
    detail: "Parent session was cancelled. Worker rows are shown as terminal even if child snapshots lag.",
    tone: "terminal",
  };
}

export function buildAgentHierarchyModel(
  run: Run,
  session: Pick<ChatSessionSnapshot, "id" | "title" | "coordination" | "workerTasks"> | undefined | null,
): AgentHierarchyModel {
  if (!session) {
    return {
      parent: {
        id: "root-loading",
        label: "Initializing Root...",
        status: "idle",
        statusLabel: "Loading",
        tone: "neutral",
        coordination: { role: "direct" },
        waitingOnDependency: false,
      },
      workers: [],
    };
  }

  const activeDependencyWorkers = (session.workerTasks ?? []).filter(
    (task) =>
      (task.dependencyMode ?? "sidecar") === "dependency" &&
      (task.status === "running" || task.status === "awaiting_approval" || task.status === "awaiting_input" || task.status === "blocked"),
  );

  const workers = [...(session.workerTasks ?? [])]
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
    .map<WorkerHierarchyNode>((task) => {
      const inheritedConstraint = describeParentConstraint(
        run.status,
        run.pauseReason ?? null,
      );
      const dependencyMode = task.dependencyMode ?? "sidecar";
      const dependencyLabel = formatDependencyMode(dependencyMode);
      return {
        id: `worker:${task.taskId}`,
        taskId: task.taskId,
        workerSessionId: task.workerSessionId,
        workerType: task.workerType,
        label: humanizeWorkerType(task.workerType),
        task: task.task,
        reason: task.reason,
        status: task.status,
        statusLabel: `${formatWorkerStatus(task.status)} · ${dependencyLabel}`,
        tone: inheritedConstraint ? inheritedConstraint.tone : getWorkerTone(task.status),
        executionMode: task.executionMode,
        dependencyMode,
        summary: task.summary,
        lastStatusReason: task.lastStatusReason,
        artifact: task.artifact,
        createdAt: task.createdAt,
        inheritedConstraint,
        raw: task,
      };
    });

  const parent: ParentHierarchyNode = {
    id: `parent:${session.id}`,
    label: session.title || run.title || "Assessment session",
    status: (run.status as RunStatus) ?? "idle",
    statusLabel: run.status ?? "idle",
    tone: getParentTone(run.status),
    coordination: session.coordination ?? null,
    waitingOnDependency: activeDependencyWorkers.length > 0,
  };

  return {
    parent,
    workers,
  };
}

export function getToneClasses(tone: AgentDisplayTone): {
  container: string;
  badge: string;
  dot: string;
} {
  switch (tone) {
    case "running":
      return {
        container: "border-border bg-muted text-muted-foreground",
        badge: "border-border bg-muted text-muted-foreground",
        dot: "bg-muted",
      };
    case "waiting":
      return {
        container: "border-amber-400/30 bg-amber-500/10 text-amber-100",
        badge: "border-amber-400/35 bg-amber-500/15 text-amber-200",
        dot: "bg-amber-300",
      };
    case "success":
      return {
        container: "border-success/30 bg-success/10 text-success",
        badge: "border-success/35 bg-success/15 text-success",
        dot: "bg-success",
      };
    case "danger":
      return {
        container: "border-red-400/30 bg-red-500/10 text-red-100",
        badge: "border-red-400/35 bg-red-500/15 text-red-200",
        dot: "bg-red-300",
      };
    case "blocked":
      return {
        container: "border-orange-400/30 bg-orange-500/10 text-orange-100",
        badge: "border-orange-400/35 bg-orange-500/15 text-orange-200",
        dot: "bg-orange-300",
      };
    case "terminal":
      return {
        container: "border-border bg-muted text-muted-foreground",
        badge: "border-border bg-muted text-muted-foreground",
        dot: "bg-muted",
      };
    default:
      return {
        container: "border-border/60 bg-background/60 text-foreground",
        badge: "border-border/60 bg-muted/20 text-muted-foreground",
        dot: "bg-muted-foreground",
      };
  }
}
