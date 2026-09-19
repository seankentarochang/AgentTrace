/**
 * Layered top-to-bottom graph layout — a small hand-rolled Sugiyama:
 * break cycles, rank by longest path, then order each layer by the
 * barycenter of its neighbours to cut edge crossings.
 *
 * Deterministic: the same entity/edge set always produces the same
 * coordinates, so the graph doesn't reshuffle as live events arrive.
 */

export interface LayoutInput {
  /** Stable order (first-seen) decides ties. */
  nodeIds: string[];
  edges: { sourceId: string; targetId: string }[];
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  layerGap: number;
  siblingGap: number;
}

const DEFAULTS: LayoutOptions = {
  nodeWidth: 190,
  nodeHeight: 62,
  layerGap: 96,
  siblingGap: 36,
};

export interface Positioned {
  x: number;
  y: number;
  rank: number;
}

/** Back edges (those closing a cycle) found by DFS, so ranking sees a DAG. */
function findBackEdges(
  nodeIds: string[],
  edges: LayoutInput["edges"],
): Set<number> {
  const outgoing = new Map<string, number[]>();
  edges.forEach((edge, i) => {
    const list = outgoing.get(edge.sourceId) ?? [];
    list.push(i);
    outgoing.set(edge.sourceId, list);
  });

  const back = new Set<number>();
  const state = new Map<string, 0 | 1 | 2>(); // unvisited | on stack | done

  const visit = (id: string) => {
    state.set(id, 1);
    for (const i of outgoing.get(id) ?? []) {
      const target = edges[i]!.targetId;
      const s = state.get(target);
      if (s === 1) back.add(i);
      else if (s === undefined) visit(target);
    }
    state.set(id, 2);
  };

  for (const id of nodeIds) if (!state.has(id)) visit(id);
  return back;
}

function rankNodes(
  nodeIds: string[],
  edges: LayoutInput["edges"],
): Map<string, number> {
  const back = findBackEdges(nodeIds, edges);
  const dag = edges.filter((_, i) => !back.has(i));

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of dag) {
    if (!incoming.has(edge.targetId) || !outgoing.has(edge.sourceId)) continue;
    if (edge.sourceId === edge.targetId) continue;
    incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1);
    outgoing.get(edge.sourceId)!.push(edge.targetId);
  }

  // Longest-path ranking over the DAG (Kahn order keeps it linear).
  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (incoming.get(id) ?? 0) === 0);
  const pending = new Map(incoming);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (pending.get(target) ?? 1) - 1;
      pending.set(target, left);
      if (left === 0) queue.push(target);
    }
  }
  return rank;
}

export function layoutGraph(
  input: LayoutInput,
  options: Partial<LayoutOptions> = {},
): Map<string, Positioned> {
  const opts = { ...DEFAULTS, ...options };
  const { nodeIds, edges } = input;
  const positions = new Map<string, Positioned>();
  if (nodeIds.length === 0) return positions;

  const rank = rankNodes(nodeIds, edges);

  const layers: string[][] = [];
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0;
    (layers[r] ??= []).push(id);
  }
  for (let r = 0; r < layers.length; r += 1) layers[r] ??= [];

  const indexIn = (layer: string[], id: string) => layer.indexOf(id);

  // Barycenter ordering, alternating sweeps. Ties fall back to the stable
  // input order so the layout never jitters between renders.
  const stableIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const neighbours = (id: string, dir: "up" | "down") =>
    edges
      .filter((e) => (dir === "up" ? e.targetId === id : e.sourceId === id))
      .map((e) => (dir === "up" ? e.sourceId : e.targetId));

  for (let pass = 0; pass < 4; pass += 1) {
    const downward = pass % 2 === 0;
    const order = downward
      ? [...layers.keys()]
      : [...layers.keys()].reverse();
    for (const r of order) {
      const adjacent = layers[downward ? r - 1 : r + 1];
      if (!adjacent) continue;
      const score = new Map<string, number>();
      for (const id of layers[r]!) {
        const ns = neighbours(id, downward ? "up" : "down")
          .map((n) => indexIn(adjacent, n))
          .filter((i) => i >= 0);
        score.set(
          id,
          ns.length > 0
            ? ns.reduce((a, b) => a + b, 0) / ns.length
            : Number.POSITIVE_INFINITY,
        );
      }
      layers[r]!.sort((a, b) => {
        const d = (score.get(a) ?? 0) - (score.get(b) ?? 0);
        if (d !== 0 && Number.isFinite(d)) return d;
        return (stableIndex.get(a) ?? 0) - (stableIndex.get(b) ?? 0);
      });
    }
  }

  const step = opts.nodeWidth + opts.siblingGap;
  const widest = Math.max(...layers.map((l) => l.length));
  for (const [r, layer] of layers.entries()) {
    const rowWidth = layer.length * step;
    const left = ((widest * step) - rowWidth) / 2;
    layer.forEach((id, i) => {
      positions.set(id, {
        x: left + i * step,
        y: r * (opts.nodeHeight + opts.layerGap),
        rank: r,
      });
    });
  }

  return positions;
}
