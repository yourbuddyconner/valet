/**
 * The sentences the events UI puts next to a delivery, as pure functions.
 *
 * A delivery row exists to answer one question: is this still coming, or is
 * it over? A `failed` row and a `dead` row look identical without a
 * countdown, and "Retries in 8 minutes" is the sentence that stops someone
 * escalating. `now` is injectable so the wording is testable without clocks.
 */
import type { EventDeliveryWire, EventSubscriptionWire } from "@valet/api/wire";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Forward-looking counterpart of `~/lib/relative-time`, which only reads
 * backwards ("5m ago"). Rounds down, so a 90-second wait reads "in 1
 * minute" and never over-promises. */
export function retryPhrase(ms: number): string {
  if (ms <= 0) return "now";
  if (ms < MINUTE) return "in less than a minute";
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    return `in ${minutes} ${plural(minutes, "minute", "minutes")}`;
  }
  const hours = Math.floor(ms / HOUR);
  return `in ${hours} ${plural(hours, "hour", "hours")}`;
}

/**
 * What the delivery is doing now, and what the reader must do about it. A
 * dead delivery names Redeliver, because that is the only way back.
 */
export function deliveryStatusLine(delivery: EventDeliveryWire, now: number): string {
  if (delivery.status === "skipped") return delivery.lastError ?? "Skipped by delivery preferences";
  const attempts = `${delivery.attempts} ${plural(delivery.attempts, "attempt", "attempts")}`;
  switch (delivery.status) {
    case "delivered":
      return attempts;
    case "dead":
      return `Gave up after ${attempts}. To send it again, press Redeliver.`;
    case "pending":
    case "failed": {
      // `nextAttemptAt` is absent only on an older server that does not send
      // it; say what is certain rather than compute a wrong countdown.
      if (delivery.nextAttemptAt == null) {
        return delivery.attempts === 0 ? "Waiting for the first attempt." : `Retry scheduled after ${attempts}.`;
      }
      const when = retryPhrase(delivery.nextAttemptAt - now);
      if (delivery.attempts === 0) {
        return when === "now" ? "Waiting for the first attempt." : `First attempt ${when}.`;
      }
      return `Retries ${when}, after ${attempts}.`;
    }
  }
}

/** Deliveries the dispatcher will still act on by itself. Redelivering while
 * one of these is scheduled can run the same work twice, so the confirm step
 * names the count. */
export function scheduledRetryCount(deliveries: EventDeliveryWire[]): number {
  return deliveries.filter((d) => d.status === "pending" || d.status === "failed").length;
}

/**
 * Enabled subscriptions whose key patterns cover this event key — the same
 * trailing-wildcard rule the server matches with. This is an UPPER BOUND and
 * is used for the confirm-step wording only: the server also applies each
 * subscription's field filters, which can only reduce the count. The server
 * stays the authority on what actually gets a delivery.
 */
export function subscriptionsMatchingKey(
  subscriptions: EventSubscriptionWire[],
  eventKey: string,
): EventSubscriptionWire[] {
  return subscriptions.filter(
    (sub) =>
      sub.enabled &&
      sub.eventKeys.some((pattern) =>
        pattern.endsWith(".*") ? eventKey.startsWith(pattern.slice(0, -1)) : pattern === eventKey,
      ),
  );
}

/** The confirm-step text. It must name the size of what the press starts:
 * redelivery can begin real agent runs. */
export function redeliverConfirmDescription(matchCount: number, scheduledCount: number): string {
  const lines: string[] =
    matchCount === 0
      ? [
          "No enabled subscription matches this event key.",
          "Redelivery creates nothing until you enable or edit one on the Subscriptions tab.",
        ]
      : [
          `This event matches up to ${matchCount} enabled ${plural(matchCount, "subscription", "subscriptions")}.`,
          `Each match creates one delivery, so this can start up to ${matchCount} ${plural(matchCount, "run", "runs")}.`,
        ];
  if (scheduledCount > 0) {
    lines.push(
      `${scheduledCount} earlier ${plural(scheduledCount, "delivery", "deliveries")} ${plural(scheduledCount, "is", "are")} still scheduled to retry.`,
      "Redelivery now can run the same work twice.",
    );
  }
  return lines.join(" ");
}

/** What the page says after the server answers. `created: 0` is a real
 * outcome, not a silent success. */
export function redeliverResultText(created: number): string {
  if (created === 0) {
    return "Nothing was queued. No enabled subscription matches this event. Enable or edit one on the Subscriptions tab, then redeliver.";
  }
  return `Queued ${created} ${plural(created, "delivery", "deliveries")}. The result appears in this list.`;
}
