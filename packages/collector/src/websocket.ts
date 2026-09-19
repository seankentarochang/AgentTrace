/**
 * WebSocket broadcast hub. The dashboard connects to /v1/live and receives
 * every normalized event as it is ingested.
 *
 * Wire format:
 *   { "kind": "event", "event": TraceEvent }  — each ingested event
 *   { "kind": "reset" }                        — store was cleared
 */
import type { TraceEvent } from "@agenttrace/protocol";
import type { WebSocket } from "ws";

export type LiveMessage =
  | { kind: "event"; event: TraceEvent }
  | { kind: "reset" };

export class LiveHub {
  private clients = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  broadcast(message: LiveMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
