import type { EventRecord } from "@loop-engineering/control-plane";

type Subscriber = (event: EventRecord) => void;

export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<Subscriber>();
    listeners.add(subscriber);
    this.subscribers.set(runId, listeners);
    return () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) this.subscribers.delete(runId);
    };
  }

  publish(event: EventRecord): void {
    for (const subscriber of this.subscribers.get(event.runId) ?? []) subscriber(event);
  }
}

export function encodeSse(event: EventRecord): string {
  return `id: ${event.sequence}\nevent: loop-event\ndata: ${JSON.stringify(event)}\n\n`;
}
