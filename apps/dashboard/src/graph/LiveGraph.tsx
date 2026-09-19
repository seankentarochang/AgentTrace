/**
 * Live agent/tool topology (spec §16). Nodes = observed entities, edges =
 * observed interactions. Edge style encodes visibility; nothing is drawn
 * that wasn't captured.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { TraceState } from "@agenttrace/protocol";
import { entityViews, viewEdges, type ViewEdge } from "../lib/derive";
import { layoutGraph } from "../lib/layout";
import { EntityNode, type EntityNodeType } from "./EntityNode";

interface Props {
  state: TraceState;
  selectedEventId?: string;
  /** Entities to keep bright; everything else dims (voice/UI highlight). */
  highlightEntityIds?: ReadonlySet<string>;
  /** Show only this entity + its downstream subtree (voice/UI isolate). */
  isolateEntityId?: string;
  /** undefined = clear the selection (pane click). */
  onSelect: (eventId?: string) => void;
}

const nodeTypes = { entity: EntityNode };

/**
 * Declared up front so React Flow knows every node's box before it measures
 * the DOM — otherwise the first fitView runs against zero-height bounds.
 * Must match the sizes in EntityNode's CSS.
 */
const NODE_WIDTH = 190;
const NODE_HEIGHT = 52;
const UNOBSERVED_EXTRA = 34;

function edgeLabel(edge: ViewEdge): string {
  const kind =
    edge.kind === "tool_call"
      ? "tool call"
      : edge.kind === "message"
        ? "message"
        : "lifecycle";
  const count = edge.eventIds.length > 1 ? ` ×${edge.eventIds.length}` : "";
  const caveat = edge.visibility === "lifecycle_only" ? " · lifecycle only" : "";
  return `${kind}${count}${caveat}`;
}

function edgeColor(edge: ViewEdge): string {
  if (edge.status === "failure") return "var(--failure)";
  if (edge.active) return "var(--warn)";
  if (edge.kind === "lifecycle") return "var(--muted)";
  return "var(--accent)";
}

function GraphCanvas({
  state,
  selectedEventId,
  highlightEntityIds,
  isolateEntityId,
  onSelect,
}: Props) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const wrapper = useRef<HTMLDivElement | null>(null);
  /** Nodes the user dragged: their positions win over the computed layout. */
  const pinned = useRef(new Set<string>());

  // maxZoom keeps a small graph from being blown up to fill the pane.
  const refit = useCallback(
    () => fitView({ padding: 0.12, duration: 300, maxZoom: 1.2 }),
    [fitView],
  );

  const selected = selectedEventId
    ? state.events.find((e) => e.eventId === selectedEventId)
    : undefined;
  // Voice/UI highlight overrides selection-driven focus when present.
  const focusIds = highlightEntityIds?.size
    ? new Set(highlightEntityIds)
    : new Set(
        [selected?.source.id, selected?.destination?.id].filter(
          Boolean,
        ) as string[],
      );

  const { nodes, edges, links } = useMemo(() => {
    let views = entityViews(state);
    let links = viewEdges(state);

    // Isolate: keep the entity plus everything reachable downstream over
    // observed edges — its subtree, nothing more.
    if (isolateEntityId) {
      const keep = new Set([isolateEntityId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const l of links) {
          if (keep.has(l.sourceId) && !keep.has(l.targetId)) {
            keep.add(l.targetId);
            grew = true;
          }
        }
      }
      views = views.filter((v) => keep.has(v.entity.ref.id));
      links = links.filter(
        (l) => keep.has(l.sourceId) && keep.has(l.targetId),
      );
    }

    // First-seen order gives the layout a stable tiebreak.
    const ordered = [...views].sort((a, b) =>
      a.entity.firstSeen < b.entity.firstSeen ? -1 : 1,
    );
    const positions = layoutGraph(
      {
        nodeIds: ordered.map((v) => v.entity.ref.id),
        edges: links.map((l) => ({ sourceId: l.sourceId, targetId: l.targetId })),
      },
      { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT + UNOBSERVED_EXTRA },
    );

    const nodes: EntityNodeType[] = ordered.map((view) => {
      const id = view.entity.ref.id;
      return {
        id,
        type: "entity" as const,
        position: positions.get(id) ?? { x: 0, y: 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT + (view.interiorUnobserved ? UNOBSERVED_EXTRA : 0),
        selected: focusIds.has(id),
        data: {
          name: view.entity.ref.name,
          entityKind: view.entity.ref.kind,
          subtype: view.entity.ref.subtype,
          status: view.entity.status,
          visibility: view.visibility,
          interiorUnobserved: view.interiorUnobserved,
          eventCount: view.entity.eventCount,
          dimmed: focusIds.size > 0 && !focusIds.has(id),
        },
      };
    });

    const edges: FlowEdge[] = links.map((link) => {
      const color = edgeColor(link);
      const involved =
        focusIds.has(link.sourceId) && focusIds.has(link.targetId);
      return {
        id: link.id,
        source: link.sourceId,
        target: link.targetId,
        label: edgeLabel(link),
        animated: link.active,
        style: {
          stroke: color,
          strokeWidth: link.visibility === "full_protocol" ? 2 : 1.4,
          strokeDasharray:
            link.visibility === "lifecycle_only" ? "6 5" : undefined,
          opacity: focusIds.size > 0 && !involved ? 0.25 : 1,
        },
        labelStyle: { fill: "var(--muted)", fontSize: 10 },
        labelBgStyle: { fill: "var(--panel)" },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        markerStart: link.bidirectional
          ? { type: MarkerType.ArrowClosed, color, width: 14, height: 14 }
          : undefined,
      };
    });

    return { nodes, edges, links };
  }, [state, selectedEventId, highlightEntityIds, isolateEntityId]);

  // Re-fit when the topology grows, but only once React Flow has measured
  // the new nodes — otherwise live events leave the view mid-zoom.
  // React Flow only measures nodes when it can report changes back, so the
  // canvas is driven through useNodesState rather than plain props.
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<EntityNodeType>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);

  // Selection is app-driven (selectedEventId -> node.selected in the memo).
  // React Flow's own select changes (node click, pane click) would desync
  // the border from the app state — drop them.
  const handleNodesChange = useCallback<typeof onNodesChange>(
    (changes) => onNodesChange(changes.filter((c) => c.type !== "select")),
    [onNodesChange],
  );
  const handleEdgesChange = useCallback<typeof onEdgesChange>(
    (changes) => onEdgesChange(changes.filter((c) => c.type !== "select")),
    [onEdgesChange],
  );

  useEffect(() => {
    setFlowNodes((prev) => {
      const previous = new Map(prev.map((n) => [n.id, n.position]));
      return nodes.map((node) =>
        pinned.current.has(node.id) && previous.has(node.id)
          ? { ...node, position: previous.get(node.id)! }
          : node,
      );
    });
  }, [nodes, setFlowNodes]);

  useEffect(() => setFlowEdges(edges), [edges, setFlowEdges]);

  // Re-fit when the topology changes and again once React Flow reports the
  // nodes measured — fitting against half-measured bounds is what leaves the
  // view zoomed into a single node.
  const topologyKey = `${nodes.map((n) => n.id).join(",")}|${edges.length}`;
  useEffect(() => {
    // A plain timer, not requestAnimationFrame: rAF never fires while the
    // tab is in the background, which would leave the graph unfitted until
    // the next interaction.
    const timer = setTimeout(refit, 120);
    return () => clearTimeout(timer);
  }, [topologyKey, nodesInitialized, refit]);

  // The pane shrinks when the assistant answers or the window resizes;
  // React Flow does not re-fit on its own.
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(refit, 120);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [refit]);

  if (nodes.length === 0) {
    return (
      <div className="empty-state">
        <p>No entities observed yet.</p>
        <p className="hint">
          Start the collector and run <code>npm run demo</code>, or switch the
          source to <b>fixture</b>.
        </p>
      </div>
    );
  }

  return (
    <div className="graph-canvas" ref={wrapper}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onPaneClick={() => onSelect(undefined)}
        onNodeDragStop={(_e, node) => pinned.current.add(node.id)}
        nodeTypes={nodeTypes}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onEdgeClick={(_e, flowEdge) => {
          const link = links.find((l) => l.id === flowEdge.id);
          const last = link?.eventIds.at(-1);
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
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} position="top-right" />
      </ReactFlow>
    </div>
  );
}

export function LiveGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
