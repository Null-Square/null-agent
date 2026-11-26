import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { 
  ParentHierarchyNode, 
  WorkerHierarchyNode 
} from '@/modules/runs/lib/agentHierarchy';
import AgentTopologyNode from './AgentTopologyNode';

const nodeTypes: NodeTypes = {
  agentNode: AgentTopologyNode,
};

export interface AgentTopologyProps {
  parent: ParentHierarchyNode;
  workers: WorkerHierarchyNode[];
  onNodeClick: (node: ParentHierarchyNode | WorkerHierarchyNode) => void;
}

export default function AgentTopology({
  parent,
  workers,
  onNodeClick,
}: AgentTopologyProps) {
  const { nodes, edges } = useMemo(() => {
    const parentNode: Node = {
      id: parent.id,
      type: 'agentNode',
      position: { x: workers.length * 150, y: 50 },
      data: {
        label: parent.label,
        eyebrow: parent.waitingOnDependency ? 'Parent / Waiting' : 'Parent',
        statusKey: parent.waitingOnDependency ? 'waiting' : parent.statusLabel,
        statusLabel: parent.waitingOnDependency ? `${parent.statusLabel} · waiting` : parent.statusLabel,
        metaLabel: parent.waitingOnDependency ? 'Dependency worker active' : 'Parent control point',
        tone: parent.tone,
        isParent: true,
      },
    };

    const workerNodes: Node[] = workers.map((worker, index) => ({
      id: worker.id,
      type: 'agentNode',
      position: { x: index * 300, y: 250 },
      data: {
        label: worker.label,
        eyebrow: worker.inheritedConstraint ? 'Sub-agent' : 'Worker',
        statusKey: worker.inheritedConstraint ? worker.status : worker.status,
        statusLabel: worker.inheritedConstraint?.label ?? worker.statusLabel,
        metaLabel: `${worker.executionMode} · ${worker.dependencyMode}`,
        tone: worker.tone,
      },
    }));

    const flowEdges: Edge[] = workers.map((worker) => ({
      id: `e-${parent.id}-${worker.id}`,
      source: parent.id,
      target: worker.id,
      // Orthogonal right-angle routing — the brand's square geometry rule
      // applies to connectors too, not just cards.
      type: 'step',
      animated: worker.tone === 'running',
      style: {
        stroke: worker.tone === 'running' ? 'var(--color-ns-yellow)' : 'var(--color-ns-elevated)',
        strokeWidth: 2,
        opacity: 0.8,
      },
    }));

    return { nodes: [parentNode, ...workerNodes], edges: flowEdges };
  }, [parent, workers]);

  return (
    <div className="h-[550px] w-full bg-background/20 relative rounded-none border border-border/40 overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => {
           if (node.id === parent.id) {
             onNodeClick(parent);
           } else {
             const worker = workers.find(w => w.id === node.id);
             if (worker) onNodeClick(worker);
           }
        }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.2}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        proOptions={{ hideAttribution: true }}
      >
        {/* Dot grid at bone alpha — the brand has no greys, so the backdrop
            dims via opacity/alpha on bone, never a raw grey hex. */}
        <Background
          color="var(--color-border)"
          gap={40}
          size={0.5}
          className="opacity-40"
        />
        <Controls
          showInteractive={false}
          className="!bg-background !border-border !rounded-none !m-4"
        />
      </ReactFlow>
    </div>
  );
}


