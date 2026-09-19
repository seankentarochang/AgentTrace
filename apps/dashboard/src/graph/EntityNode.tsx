/**
 * Graph node for one observed entity (spec §16).
 *
 * The node states plainly how much AgentTrace could see: the visibility
 * badge is the best level observed, and an agent whose interior was never
 * captured gets an explicit "?" boundary instead of an empty-looking box.
 */
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { Entity, EntityRef, Visibility } from "@agenttrace/protocol";
import { VISIBILITY_LABEL, VISIBILITY_SHORT } from "../lib/derive";

export type EntityNodeData = {
  name: string;
  entityKind: EntityRef["kind"];
  subtype?: string;
  status: Entity["status"];
  visibility?: Visibility;
  interiorUnobserved: boolean;
  eventCount: number;
  dimmed: boolean;
};

export type EntityNodeType = Node<EntityNodeData, "entity">;

const KIND_GLYPH: Record<EntityRef["kind"], string> = {
  agent: "◆",
  tool: "▸",
  model: "◇",
  external_service: "☁",
};

export function EntityNode({ data, selected }: NodeProps<EntityNodeType>) {
  const {
    name,
    entityKind,
    subtype,
    status,
    visibility,
    interiorUnobserved,
    eventCount,
    dimmed,
  } = data;

  return (
    <div
      className={[
        "entity-node",
        `kind-${entityKind}`,
        `status-${status}`,
        selected ? "is-selected" : "",
        dimmed ? "is-dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Handle type="target" position={Position.Top} />
      <div className="entity-node-head">
        <span className="entity-glyph">{KIND_GLYPH[entityKind]}</span>
        <span className="entity-name" title={name}>
          {name}
        </span>
        <span className={`status-dot status-${status}`} title={status} />
      </div>
      <div className="entity-node-meta">
        <span>{subtype ?? entityKind}</span>
        <span>·</span>
        <span>{eventCount} ev</span>
        {visibility && (
          <span
            className={`vis-badge vis-${visibility}`}
            title={`observed at: ${VISIBILITY_LABEL[visibility]}`}
          >
            {VISIBILITY_SHORT[visibility]}
          </span>
        )}
      </div>
      {interiorUnobserved && (
        <div
          className="entity-unobserved"
          title="This agent's lifecycle — and any messages it exchanged — were observed, but nothing about its internal work was captured. AgentTrace does not guess what happened here."
        >
          ? internal activity unavailable
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
