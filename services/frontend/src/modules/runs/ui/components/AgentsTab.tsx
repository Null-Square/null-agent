import { useMemo, useState } from "react";
import type { Run } from "@/modules/security-ops/types";
import type { ChatSessionSnapshot } from "@/types/chat";
import { useSessionTopologyQuery } from "@modules/sessions";
import {
  buildAgentHierarchyModel,
  ParentHierarchyNode,
  WorkerHierarchyNode,
} from "@/modules/runs/lib/agentHierarchy";
import AgentTopology from "./AgentTopology";
import AgentDetailsModal from "./AgentDetailsModal";
import { isTerminalRunStatus } from "../../lib/runStatus";

export interface AgentsTabProps {
  run: Run;
  session?: ChatSessionSnapshot | null;
}

export default function AgentsTab({ run, session }: AgentsTabProps) {
  const [selectedNode, setSelectedNode] = useState<ParentHierarchyNode | WorkerHierarchyNode | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const canonicalSessionId =
    run.executorSessionId ??
    run.sessionId ??
    run.activeSessionId ??
    session?.id;
  const {
    data: canonicalSession,
    isLoading: isLoadingTopology,
    isError: isTopologyError,
  } = useSessionTopologyQuery(canonicalSessionId, {
    staleTime: 0,
    refetchInterval: isTerminalRunStatus(run.status) ? false : 2_000,
    refetchOnMount: "always",
  });
  const effectiveSession = canonicalSession ?? session;

  // Always prefer the canonical parent snapshot so worker tasks stay visible even if the page hydrated an older session first.
  const model = useMemo(
    () => buildAgentHierarchyModel(run, effectiveSession),
    [effectiveSession, run],
  );

  const handleNodeClick = (node: ParentHierarchyNode | WorkerHierarchyNode) => {
    // Prevent opening details for the loading node
    if (node.id === 'root-loading') return;
    
    setSelectedNode(node);
    setIsModalOpen(true);
  };

  const selectedSessionId = useMemo(() => {
    if (!selectedNode) return undefined;
    if ("workerSessionId" in selectedNode) {
      return (selectedNode as WorkerHierarchyNode).workerSessionId;
    }
    return canonicalSessionId;
  }, [selectedNode, canonicalSessionId]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-xl font-bold  tracking-tight text-foreground">
            Multi-Agent Topology
          </h3>
          <div className="flex items-center gap-2 mt-1">
            {!effectiveSession && isTopologyError ? (
              <div className="flex items-center gap-2">
                 <div className="h-2 w-2 bg-destructive" />
                 <span className="text-sm font-sans text-destructive  tracking-tight font-bold">Topology sync failed</span>
              </div>
            ) : !effectiveSession || isLoadingTopology ? (
              <div className="flex items-center gap-2">
                 <div className="ns-live-mark h-2 w-2 bg-primary" />
                 <span className="text-sm font-sans text-primary  tracking-tight font-bold">Synchronizing telemetry...</span>
              </div>
            ) : (
              <p className="text-sm font-sans text-muted-foreground  tracking-tight leading-none">
                Visualizing the delegation and session hierarchy
              </p>
            )}
          </div>
        </div>
      </div>

      <AgentTopology 
         parent={model.parent} 
         workers={model.workers} 
         onNodeClick={handleNodeClick} 
      />

      <AgentDetailsModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        node={selectedNode}
        sessionId={selectedSessionId}
        runStatus={run.status}
      />
    </div>
  );
}


