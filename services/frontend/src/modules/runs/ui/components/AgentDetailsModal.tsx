import { useEffect, useState } from "react";
import { Badge, Modal } from "@null-ai/design-tokens/ui";
import { Bot, Terminal, Activity, ShieldAlert } from "lucide-react";
import { cn } from "@null-ai/design-tokens/ui";
import type { ParentHierarchyNode, WorkerHierarchyNode } from "@/modules/runs/lib/agentHierarchy";
import AgentResponseFeed from "./AgentResponseFeed";
import { isTerminalRunStatus } from "../../lib/runStatus";

export interface AgentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  node: ParentHierarchyNode | WorkerHierarchyNode | null;
  sessionId?: string;
  runStatus?: string;
}

export default function AgentDetailsModal({
  isOpen,
  onClose,
  node,
  sessionId,
  runStatus,
}: AgentDetailsModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen || !mounted || !node) return null;

  const isWorker = 'taskId' in node;
  const workerNode = isWorker ? (node as WorkerHierarchyNode) : null;
  const parentNode = !isWorker ? (node as ParentHierarchyNode) : null;
  const enumerationTask =
    workerNode?.workerType === "enumeration_worker" ? workerNode.raw : undefined;
  const enumerationMission = enumerationTask?.mission?.enumeration;
  const enumerationResult = enumerationTask?.artifact?.enumeration;
  const enumerationDisposition = enumerationTask?.enumerationDisposition;
  const attackTask =
    workerNode?.workerType === "attack_worker" ? workerNode.raw : undefined;
  const attackMission = attackTask?.mission?.attack;
  const attackResult = attackTask?.artifact?.attack;
  const attackDisposition = attackTask?.attackDisposition;
  const isTerminal =
    isTerminalRunStatus(runStatus) || isTerminalRunStatus(node.status);

  return (
    <Modal isOpen onClose={onClose} title={node.label} size="xl">
        {/* Header - Consolidated with Metadata */}
        <div className="flex items-start justify-between p-6 border-b border-border/10">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                {node.label}
              </h2>
              <Badge className="border-primary/20 bg-primary/5 text-primary font-sans text-xs font-bold px-2 py-0.5">
                {node.statusLabel}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-sans text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Bot className="h-3 w-3" />
                {isWorker ? 'Sub-Agent' : 'Parent Executor'}
              </span>
              <span>
                ID: <span className="text-foreground/70">{isWorker ? workerNode?.taskId : sessionId ?? 'ROOT'}</span>
              </span>
              {isWorker && workerNode?.dependencyMode ? (
                <span>{workerNode.dependencyMode === 'dependency' ? 'Dependency' : 'Sidecar'}</span>
              ) : null}
              {workerNode?.artifact?.confidence !== undefined ? (
                <span>
                  Confidence:{' '}
                  <span className="text-primary font-bold">
                    {Math.round(workerNode.artifact.confidence * 100)}%
                  </span>
                </span>
              ) : null}
              {!isWorker && parentNode?.waitingOnDependency ? (
                <span className="text-warning">Waiting on dependency</span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto custom-scrollbar">

          {/* Instruction brief (workers only) — what this agent was asked to do */}
          {isWorker && workerNode?.task ? (
            <div className="px-6 py-5 border-b border-border/10 space-y-3">
              <div className="flex items-center gap-2 font-sans text-sm font-bold text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" />
                Instruction
              </div>
              <p className="text-sm text-foreground/90 leading-relaxed font-sans max-w-2xl">
                {workerNode.task}
              </p>
              {workerNode?.reason ? (
                <p className="text-sm text-muted-foreground italic leading-normal max-w-2xl">
                  {workerNode.reason}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Response feed — the focus */}
          {enumerationTask ? (
            <div className="px-6 py-5 border-b border-border/10 space-y-4 text-sm">
              <div className="flex items-center gap-2 font-sans text-sm font-bold text-muted-foreground">
                <Activity className="h-3.5 w-3.5" />
                Enumeration contract
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <span className="text-muted-foreground">Plan step</span>
                  <p className="text-foreground break-all">{enumerationTask.planStepId ?? "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Target / surface</span>
                  <p className="text-foreground break-all">
                    {enumerationMission?.targetRef ?? "—"}
                    {enumerationMission
                      ? ` · ${enumerationMission.surface.kind}: ${enumerationMission.surface.refs.join(", ")}`
                      : ""}
                  </p>
                </div>
                <div className="md:col-span-2">
                  <span className="text-muted-foreground">Pinned skills</span>
                  <div className="space-y-1 text-foreground">
                    {enumerationMission ? (
                      [enumerationMission.primarySkill, ...enumerationMission.supportingSkills].map((skill) => (
                        <p key={`${skill.slug}:${skill.versionHash}`} className="break-all">
                          {skill.slug} · {skill.versionHash}
                        </p>
                      ))
                    ) : (
                      <p>—</p>
                    )}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Budget</span>
                  <p className="text-foreground">
                    {enumerationTask.targetRequestsUsed ?? 0}/{enumerationTask.budget?.maxTargetRequests ?? "—"} requests
                    {" · "}
                    {enumerationTask.budget?.maxRequestConcurrency ?? "—"} concurrent
                    {" · "}
                    {enumerationTask.budget?.maxWallSeconds ?? "—"}s wall
                    {" · "}
                    {enumerationTask.enumerationAttempts?.length ?? 0} metered attempts
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Deadline</span>
                  <p className="text-foreground">
                    {enumerationTask.deadlineAt
                      ? new Date(enumerationTask.deadlineAt).toLocaleString()
                      : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Capability</span>
                  <p className="text-foreground">
                    {enumerationTask.enumerationCapability
                      ? `${enumerationTask.enumerationCapability.cohort} · policy ${enumerationTask.enumerationCapability.policyVersion} · ${enumerationTask.enumerationCapability.catalogVersion}`
                      : "Legacy / unavailable"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Result schema</span>
                  <p className="text-foreground">
                    {enumerationResult
                      ? `enumeration_result/v${enumerationResult.schemaVersion} · ${enumerationResult.status}`
                      : enumerationTask.lastError ?? "Pending typed result"}
                  </p>
                </div>
              </div>

              {enumerationResult ? (
                <div className="grid gap-3 md:grid-cols-4">
                  <div><span className="text-muted-foreground">Leads</span><p>{enumerationResult.leads.length}</p></div>
                  <div><span className="text-muted-foreground">Negatives</span><p>{enumerationResult.negativeResults.length}</p></div>
                  <div><span className="text-muted-foreground">Blockers</span><p>{enumerationResult.blockers.length}</p></div>
                  <div><span className="text-muted-foreground">Artifacts</span><p>{enumerationResult.artifacts.length}</p></div>
                  <div className="md:col-span-4">
                    <span className="text-muted-foreground">Coverage</span>
                    <p className="text-foreground">
                      {enumerationResult.coverage.counts.attempts} attempts ·{" "}
                      {enumerationResult.coverage.counts.requests} requests ·{" "}
                      {enumerationResult.coverage.uncovered.length} uncovered
                    </p>
                  </div>
                  {enumerationResult.artifacts.length > 0 ? (
                    <div className="md:col-span-4">
                      <span className="text-muted-foreground">Artifact links</span>
                      {enumerationResult.artifacts.map((artifact) => (
                        <p key={artifact.id} className="text-foreground break-all">{artifact.path}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div>
                <span className="text-muted-foreground">Parent disposition</span>
                <p className="text-foreground">
                  {enumerationDisposition
                    ? `${enumerationDisposition.action} · ${enumerationDisposition.leadDispositions.length} lead decisions`
                    : "Pending"}
                </p>
                {enumerationDisposition?.canonicalLeadIds.length ? (
                  <p className="text-foreground break-all">
                    Canonical leads: {enumerationDisposition.canonicalLeadIds.join(", ")}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {attackTask ? (
            <div className="px-6 py-5 border-b border-warning/20 space-y-4 text-sm">
              <div className="flex items-center gap-2 font-sans text-sm font-bold text-warning">
                <ShieldAlert className="h-3.5 w-3.5" />
                Controlled exploitation contract
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <span className="text-muted-foreground">Objective</span>
                  <p className="text-foreground">
                    {attackMission
                      ? `${attackMission.objectiveFamily}: ${attackMission.objective}`
                      : "-"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Validated risk IDs</span>
                  <p className="text-foreground break-all">
                    {attackMission?.validatedFindingIds.join(", ") ?? "-"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Exact target</span>
                  <p className="text-foreground break-all">{attackMission?.targetRef ?? "-"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Budget</span>
                  <p className="text-foreground">
                    {attackTask.targetRequestsUsed ?? 0}/{attackMission?.requestBudget ?? "-"} requests
                    {" / "}
                    {attackMission?.toolBudget ?? "-"} tools
                    {" / "}
                    {attackMission?.timeBudgetSeconds ?? "-"}s
                    {" / "}
                    {attackMission?.maxRequestConcurrency ?? 1} concurrent
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <p className="text-foreground">
                    {attackResult?.status ?? attackTask.lastError ?? attackTask.status}
                  </p>
                </div>
              </div>

              {attackResult ? (
                <div className="space-y-3 border-l-2 border-border py-3 pl-4">
                  <div>
                    <span className="text-muted-foreground">Impact proof</span>
                    <p className="text-foreground">{attackResult.proofClaim}</p>
                    {attackResult.changedStateSummary ? (
                      <p className="text-foreground/80">Changed state: {attackResult.changedStateSummary}</p>
                    ) : null}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Evidence</span>
                    <p className="text-foreground break-all">
                      {attackResult.evidenceIds.join(", ") || "None recorded"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Cleanup</span>
                    <p
                      className={cn(
                        "font-bold",
                        attackResult.cleanup.status === "failed" ||
                          attackResult.cleanup.status === "unknown"
                          ? "text-destructive"
                          : "text-foreground",
                      )}
                    >
                      {attackResult.cleanup.status}
                      {attackResult.cleanup.remainingRisk
                        ? ` - ${attackResult.cleanup.remainingRisk}`
                        : ""}
                    </p>
                    <p className="text-foreground/80">
                      {attackResult.cleanup.actions.join("; ") || "No cleanup action recorded"}
                    </p>
                    {attackResult.cleanup.evidenceIds.length > 0 ? (
                      <p className="text-foreground break-all">
                        Cleanup evidence: {attackResult.cleanup.evidenceIds.join(", ")}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div>
                <span className="text-muted-foreground">Parent disposition</span>
                <p className="text-foreground">
                  {attackDisposition
                    ? `${attackDisposition.action}${attackDisposition.resultStatus ? ` / ${attackDisposition.resultStatus}` : ""}`
                    : "Pending"}
                </p>
                {attackDisposition?.terminalReason ? (
                  <p className="text-warning">{attackDisposition.terminalReason}</p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="flex-1 flex flex-col min-h-[400px]">
            <div className="px-6 pt-6 pb-3 flex items-center gap-2">
              <Activity className="h-3 w-3 text-primary" />
              <span className="text-sm font-bold text-muted-foreground">Response Feed</span>
            </div>
            <div className="flex-1">
              <AgentResponseFeed
                sessionId={sessionId}
                className="h-full"
                isTerminal={isTerminal}
              />
            </div>
          </div>
        </div>

    </Modal>
  );
}


