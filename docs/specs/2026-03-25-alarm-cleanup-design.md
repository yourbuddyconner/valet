# SessionAgentDO Alarm Cleanup

## Problem

DOs with no active sandbox fire alarms indefinitely, hammering D1 with flushMetrics and other writes. With hundreds of zombie DOs, this overloads D1 and causes cascading 500s across the entire app.

Root causes:
1. **Runner disconnect doesn't trigger cleanup.** When the sandbox dies and the runner WebSocket closes, the DO sits idle with its alarm still firing. It relies on the idle timeout (15+ minutes) to eventually hibernate — far too slow.
2. **Alarm re-arms unconditionally.** Even after triggering hibernation, the alarm re-arms at the end of the handler. If hibernation fails (D1 overload), the DO wakes up next tick and tries again.
3. **No liveness check.** The alarm handler never asks "should I be alive?" DOs in terminal states or with nothing to do still re-arm.
4. **Per-alarm flushMetrics was the biggest D1 load contributor.** Every alarm tick wrote metrics to D1, even when nothing changed.

## Design

### Runner Disconnect Grace Period

When the runner WebSocket closes in `webSocketClose()`:
- Set `this.runnerDisconnectedAt = Date.now()`
- Schedule an alarm for 60s from now

When the runner reconnects in `upgradeRunner()`:
- Clear `this.runnerDisconnectedAt = null`

When the alarm fires and `runnerDisconnectedAt` is set and 60s has elapsed:
- Call `handleStop('sandbox_lost')` — same termination path as a normal stop
- This flushes metrics, updates D1 status, notifies clients
- Terminal state prevents alarm re-arm (see below)

The 60s grace covers:
- Network blips — runner reconnects within seconds
- Sandbox restart — new runner connects within ~30s
- Sandbox gone forever — clean termination after 60s instead of zombie DO

### Alarm Early Exit

At the top of `alarm()`, before any phases:

```typescript
const status = this.sessionState.status;
if (['terminated', 'archived', 'error', 'hibernated'].includes(status)) {
  return; // don't re-arm
}
```

### Alarm Conditional Re-arm

Replace the unconditional `this.lifecycle.scheduleAlarm(this.collectAlarmDeadlines())` at the end of `alarm()` with:

```typescript
const deadlines = this.collectAlarmDeadlines();
const hasWork = deadlines.some(d => d !== null);
const hasConnections = this.runnerLink.isConnected || this.getClientSockets().length > 0;
const hasPendingGrace = this.runnerDisconnectedAt !== null;

if (hasWork || hasConnections || hasPendingGrace) {
  this.lifecycle.scheduleAlarm(deadlines);
} else {
  // Nothing to do — let Cloudflare evict this DO from memory.
  // It will wake from hibernation storage on demand if needed.
}
```

A DO with no runner, no clients, no pending prompts, no followups, and no grace period simply stops firing alarms. Cloudflare evicts it. If someone connects later, the DO wakes from hibernation storage on demand.

### Remove Periodic flushMetrics

Permanently remove the commented-out `flushMetrics()` call from the alarm handler. Metrics flush at lifecycle boundaries only:
- `handleStop()` — session termination
- `performHibernate()` — session hibernation
- Prompt `complete` handler — after each agent turn
- `handleGarbageCollect()` — cleanup path

### collectAlarmDeadlines Update

Add the runner disconnect grace deadline to the deadlines array:

```typescript
private collectAlarmDeadlines(): (number | null)[] {
  // ... existing deadlines ...
  const gracePeriod = this.runnerDisconnectedAt
    ? this.runnerDisconnectedAt + 60_000
    : null;

  return [promptExpiry, followupMs, watchdog, safetyNet, parentIdle, gracePeriod];
}
```

## Files Changed

| File | Change |
|---|---|
| `packages/worker/src/durable-objects/session-agent.ts` | Runner disconnect grace period, alarm early exit, conditional re-arm, remove flushMetrics comment, update collectAlarmDeadlines |

## What This Does NOT Change

- The 7 alarm phases (collect flush, idle check, watchdogs, followups, etc.) — they stay as-is
- How alarms are scheduled from other call sites (interactive prompts, action expiry)
- The lifecycle class or session state class
- Any external API or WebSocket protocol
