/**
 * The one way an event or a followed message is delivered to an assistant:
 * resolve the session, assert its org against the delivery's org (the
 * second-layer defense `admitSignal` would have provided — an event has no
 * sender session, so there is no edge to authorize), then submit the signal on
 * the named thread. Both the dispatcher's orchestrator target
 * (`orchestrator-target.ts`) and the follow-router (`channels/follow-router.ts`)
 * go through here, so the org check and delivery shape can never drift between
 * them.
 *
 * The workspace owner determines the assistant.
 */
import type { ChannelOrigin, Principal, Session, SignalContent } from "@valet/engine";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { writeDropLog } from "../orchestrator/signals.js";

/**
 * Per-thread delivery serialization (TKAI-284 item 3). The first-turn seed
 * check reads the thread, then fetches a transcript (a slow provider call),
 * then submits — two rapid mentions on one brand-new thread could both pass
 * the empty check during the other's fetch and both prepend the transcript.
 * Chaining deliveries per assistant thread closes that window. In-process
 * state is sufficient: the api runs single-replica (see the issue), and a
 * restart between the two deliveries is covered by the unsettled-submission
 * arm of the seed gate below.
 */
const deliveryChains = new Map<string, Promise<void>>();

export interface AssistantDeliveryDeps {
  db: AppDb;
  engineHost: EngineHost;
  /**
   * Seed a channel thread's earlier messages on the assistant's FIRST turn in
   * it. Wired only on the mention path (`orchestrator-target`); the follow
   * path never delivers first, so it leaves this unset.
   */
  fetchThreadContext?: (origin: ChannelOrigin) => Promise<string | null>;
}

export interface AssistantDeliveryArgs {
  orgId: string;
  owner: Principal;
  actorUserId: string;
  threadKey: string;
  signal: SignalContent;
  dispatchId: string;
  /** Drop-log reason if the resolved assistant belongs to another org. */
  mismatchReason: string;
}

export async function deliverToAssistantThread(
  deps: AssistantDeliveryDeps,
  args: AssistantDeliveryArgs,
): Promise<void> {
  // Serialize by runtime session and thread so delivery paths share one queue.
  const { session } = await ensureDefaultAssistantSession(deps, args.owner, {
    actorUserId: args.actorUserId, orgId: args.orgId,
  });
  const key = `${session.id}:${args.threadKey}`;
  const prior = deliveryChains.get(key) ?? Promise.resolve();
  const run = prior.then(() => deliverToAssistantThreadInner(deps, args, session));
  // The stored tail swallows the failure (the caller gets it from `run`) and
  // removes itself once it is still the tail, so the map does not keep one
  // settled promise per thread ever delivered to.
  const tail: Promise<void> = run
    .catch(() => undefined)
    .then(() => {
      if (deliveryChains.get(key) === tail) deliveryChains.delete(key);
    });
  deliveryChains.set(key, tail);
  return run;
}

async function deliverToAssistantThreadInner(
  deps: AssistantDeliveryDeps,
  args: AssistantDeliveryArgs,
  session: Session,
): Promise<void> {
  const data = await session.toData();
  if (data.orgId !== args.orgId) {
    await writeDropLog(deps.db, {
      orgId: args.orgId,
      reason: args.mismatchReason,
      conversationKey: args.dispatchId,
      detail: `assistant session ${session.id} belongs to org ${data.orgId}, delivery belongs to org ${args.orgId}`,
    });
    throw new Error(`delivery refused: assistant org mismatch (${data.orgId} != ${args.orgId})`);
  }
  const thread = await deps.engineHost.ensureFreshThread(session, args.threadKey, {
    userId: data.userId,
    orgId: data.orgId,
    workspace: data.workspace,
  }, args.actorUserId);
  let signal = args.signal;
  // On the assistant's FIRST turn in a channel thread, prepend the thread's
  // earlier messages so it participates in the group conversation with full
  // context instead of the lone trigger message. Later messages already stream
  // in on the same thread, so a thread that already has entries never re-seeds.
  // "First" is entries AND unsettled submissions both empty: an admitted-but-
  // unclaimed submission has written no entry yet, and a second mention racing
  // it must not seed the transcript a second time. (In-process ordering is
  // handled by the per-thread chain in `deliverToAssistantThread`; the
  // submission check covers an api restart between admit and claim.)
  if (deps.fetchThreadContext && signal.origin) {
    const store = session.providers.store;
    const existing = await store.getEntries(session.id, thread.id);
    if (existing.length === 0) {
      const unsettled = await store.listUnsettledSubmissions(session.id);
      if (!unsettled.some((item) => item.threadId === thread.id)) {
        const transcript = await deps.fetchThreadContext(signal.origin);
        if (transcript) {
          signal = { ...signal, body: `Conversation so far in this thread:\n${transcript}\n\n---\n\n${signal.body}` };
        }
      }
    }
  }
  await thread.submitPrompt(signal, {
    dispatchId: args.dispatchId,
    author: { id: args.actorUserId },
  });
}
