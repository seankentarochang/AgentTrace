/**
 * Live agent/tool topology (spec §16). Nodes = entities, edges = observed
 * interactions. Edge style encodes visibility — never imply more
 * visibility than the data has.
 *
 * TODO(track-2): proper layered layout (dagre), unobservable-boundary
 * rendering, node status colors, auto-fit on new nodes.
 */
import { useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Edge, TraceState } from "@agenttrace/protocol";

interface Props {
  state: TraceState;
  onSelect: (eventId: string) => void;
}

/** Simple layered layout: BFS depth -> x, index within layer -> y. */
function layout(state: TraceState): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const roots = Object.keys(state.entities).filter(
    (id) => !Object.values(state.edges).some((e) => e.destinationId === id),
  );
  const queue = roots.length > 0 ? [...roots] : Object.keys(state.entities).slice(0, 1);
  for (const id of queue) depth.set(id, 0);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const edge of Object.values(state.edges)) {
      if (edge.sourceId !== id) continue;
      const next = edge.destinationId;
      if (!depth.has(next) || (depth.get(next) ?? 0) < d + 1) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  for (const id of Object.keys(state.entities)) {
    if (!depth.has(id)) depth.set(id, 0);
  }

  const perLayer = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, d] of depth) {
    const index = perLayer.get(d) ?? 0;
    perLayer.set(d, index + 1);
    positions.set(id, { x: d * 230, y: index * 100 });
  }
  return positions;
}

function edgeStyle(edge: Edge): { animated: boolean; dashed: boolean } {
  return {
    animated: edge.status === "started",
    dashed: edge.visibility === "lifecycle_only",
  };
}

export function LiveGraph({ state, onSelect }: Props) {
  const { nodes, edges } = useMemo(() => {
    const positions = layout(state);
    const nodes: FlowNode[] = Object.values(state.entities).map((entity) => ({
      id: entity.ref.id,
      position: positions.get(entity.ref.id) ?? { x: 0, y: 0 },
      data: { label: `${entity.ref.name} (${entity.ref.kind})` },
      style: {
        background: "var(--panel)",
        color: "var(--text)",
        border: `1px solid ${entity.status === "failure" ? "var(--failure)" : "var(--border)"}`,
        borderRadius: 8,
        fontSize: 12,
        width: 180,
      },
    }));
    const edges: FlowEdge[] = Object.values(state.edges).map((edge) => {
      const { animated, dashed } = edgeStyle(edge);
      return {
        id: edge.id,
        source: edge.sourceId,
        target: edge.destinationId,
        label: `${edge.kind} x${edge.eventIds.length}`,
        animated,
        style: {
          stroke: edge.status === "failure" ? "var(--failure)" : "var(--accent)",
          strokeDasharray: dashed ? "6 4" : undefined,
        },
        labelStyle: { fill: "var(--muted)", fontSize: 10 },
        markerEnd: { type: MarkerType.ArrowClosed },
      };
    });
    return { nodes, edges };
  }, [state]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      onEdgeClick={(_e, edge) => {
        const last = state.edges[edge.id]?.eventIds.at(-1);
        if (last) onSelect(last);
      }}
      onNodeClick={(_e, node) => {
        const last = state.events.findLast(
          (ev) => ev.source.id === node.id || ev.destination?.id === node.id,
        );
        if (last) onSelect(last.eventId);
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
