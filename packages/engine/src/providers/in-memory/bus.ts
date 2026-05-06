import type { BusEvent, EventBus, EventFilter, Unsubscribe } from "../../types.js";

interface Subscription {
  filter: EventFilter;
  callback: (event: BusEvent) => void;
}

export class InMemoryEventBus implements EventBus {
  private subs = new Set<Subscription>();

  async publish(event: BusEvent): Promise<void> {
    for (const sub of this.subs) {
      if (matches(sub.filter, event)) sub.callback(event);
    }
  }

  subscribe(filter: EventFilter, callback: (event: BusEvent) => void): Unsubscribe {
    const sub: Subscription = { filter, callback };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }
}

function matches(filter: EventFilter, event: BusEvent): boolean {
  if (filter.sessionId && filter.sessionId !== event.sessionId) return false;
  if (filter.userId && filter.userId !== event.userId) return false;
  if (filter.eventTypes && !filter.eventTypes.includes(event.event.type)) return false;
  return true;
}
