/**
 * Renders a pending DecisionGate as an inline card above the Composer.
 *
 * The agent is paused on `blocked_on_decision_gate` while this is showing —
 * the user must choose an action (approval / credential_request) or supply
 * a value (question) for the engine to resume the suspended turn.
 *
 * Scoping: the parent passes the gate that belongs to the *active* thread.
 * If the user switches threads, this component unmounts; the gate keeps
 * pending in the store and the agent stays blocked until the user comes
 * back and answers — matching the engine's per-thread suspend model.
 */
import { useState } from "react";
import { AlertTriangle, HelpCircle, KeyRound, X } from "lucide-react";
import type { DecisionGate } from "@valet/api/wire";
import { Button, Spinner, Textarea, Tooltip } from "~/components/primitives";
import { useResolveDecision, useWithdrawDecision } from "~/api/queries";
import { useMe } from "~/api/settings";
import { cn } from "~/lib/cn";

// The gate action id the policy resolver offers on a `require_approval`
// decision that grants an org-wide `allow` policy going forward — the API
// 403s it for non-admins at resolve (`org admin required for
// always_allow`, `routes/messages.ts`). Hardcoded here (not imported) since
// it's a server-internal constant (`policies/service.ts`'s
// `GATE_ACTION_ALWAYS_ALLOW`), not part of the wire contract.
const GATE_ACTION_ALWAYS_ALLOW = "always_allow";
const ALWAYS_ALLOW_TOOLTIP = "Only an org admin can always-allow this action.";

export function DecisionGateCard({
  sessionId,
  gate,
}: {
  sessionId: string;
  gate: DecisionGate;
}) {
  const resolve = useResolveDecision(sessionId);
  const withdraw = useWithdrawDecision(sessionId);
  const meQ = useMe();
  const isAdmin = meQ.data?.orgRole === "admin";
  const [value, setValue] = useState("");

  const busy = resolve.isPending || withdraw.isPending;

  async function pickAction(actionId: string) {
    if (busy) return;
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { actionId } });
    } catch (err) {
      console.error("resolve gate failed:", err);
    }
  }

  async function submitValue() {
    const v = value.trim();
    if (!v || busy) return;
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { value: v } });
      setValue("");
    } catch (err) {
      console.error("resolve gate (value) failed:", err);
    }
  }

  async function cancel() {
    if (busy) return;
    try {
      await withdraw.mutateAsync({ gateId: gate.id });
    } catch (err) {
      console.error("withdraw gate failed:", err);
    }
  }

  const Icon = ICON_FOR_TYPE[gate.type];
  const tone = TONE_FOR_TYPE[gate.type];

  return (
    <div
      className={cn(
        "border-t border-x mx-3 mt-3 rounded-md",
        "border-amber-300 dark:border-amber-700/60",
        "bg-amber-50/70 dark:bg-amber-950/40",
      )}
      role="dialog"
      aria-live="polite"
      aria-labelledby={`gate-${gate.id}-title`}
    >
      <header className="flex items-start gap-2.5 px-3.5 pt-3 pb-1.5">
        <span
          className={cn(
            "mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full",
            tone.iconBg,
          )}
        >
          <Icon className={cn("h-3.5 w-3.5", tone.iconFg)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn("text-[10px] font-semibold uppercase tracking-wider", tone.label)}>
            {LABEL_FOR_TYPE[gate.type]} • agent paused
          </div>
          <h3
            id={`gate-${gate.id}-title`}
            className="text-sm font-semibold text-[--fg] mt-0.5"
          >
            {gate.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          aria-label="Cancel and dismiss"
          className="text-muted hover:text-[--fg] disabled:opacity-50 -mr-1 mt-0.5"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {gate.body && (
        <div className="px-3.5 pb-2 text-xs text-muted whitespace-pre-wrap">
          {gate.body}
        </div>
      )}

      {gate.provenance && (
        <div className="px-3.5 pb-2 text-[11px] text-muted" data-testid="gate-provenance">
          {provenanceLine(gate.provenance)}
        </div>
      )}

      {gate.type === "question" ? (
        <div className="px-3.5 pb-3 flex items-end gap-2">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Your answer…"
            rows={2}
            className="flex-1 bg-white/70 dark:bg-neutral-900/40"
            disabled={busy}
          />
          <Button
            onClick={submitValue}
            disabled={busy || value.trim().length === 0}
          >
            {busy ? <Spinner size={14} /> : "Submit"}
          </Button>
        </div>
      ) : (
        <div className="px-3.5 pb-3 flex flex-wrap gap-2">
          {gate.actions.map((a) => {
            const isAlwaysAllow = a.id === GATE_ACTION_ALWAYS_ALLOW;
            const disabled = busy || (isAlwaysAllow && !isAdmin);
            const button = (
              <Button
                key={a.id}
                onClick={() => pickAction(a.id)}
                disabled={disabled}
                variant={
                  a.style === "primary"
                    ? "primary"
                    : a.style === "danger"
                      ? "danger"
                      : "secondary"
                }
              >
                {busy && resolve.variables?.gateId === gate.id ? (
                  <Spinner size={14} />
                ) : null}
                <span>{a.label}</span>
              </Button>
            );
            // `isAdmin` reads `false` while `useMe()` is still loading —
            // fail-closed (disabled + tooltip) rather than briefly offering
            // a button the API will 403.
            if (isAlwaysAllow && !isAdmin) {
              return (
                <Tooltip key={a.id} content={ALWAYS_ALLOW_TOOLTIP}>
                  <span>{button}</span>
                </Tooltip>
              );
            }
            return button;
          })}
        </div>
      )}
    </div>
  );
}

/** One line naming the precedence rung that gated this call. Policy/override
 * rungs link nowhere from here (the Action Log carries the row links); this
 * is the live "why" the spec's decision 4 promised. */
function provenanceLine(p: NonNullable<DecisionGate["provenance"]>): string {
  // Cases mirror the engine's `PolicyProvenanceSource` values exactly.
  switch (p.source) {
    case "team_policy":
      return "Gated by a team policy.";
    case "org_policy":
      return "Gated by an org policy.";
    case "override":
      return "Gated by your personal policy override.";
    case "runtime_grant":
      return "Gated by a runtime grant.";
    case "plugin_default":
      return "Gated by the plugin's default approval mode.";
    case "risk_default":
      return "Gated by the action's risk level.";
    case "resolver_error":
      return "Policy check failed — approval requested as a safe fallback.";
    default:
      return `Gated by policy (${p.source}).`;
  }
}

const ICON_FOR_TYPE = {
  approval: AlertTriangle,
  question: HelpCircle,
  credential_request: KeyRound,
} as const;

const LABEL_FOR_TYPE: Record<DecisionGate["type"], string> = {
  approval: "Approval needed",
  question: "Question",
  credential_request: "Credential needed",
};

const TONE_FOR_TYPE: Record<
  DecisionGate["type"],
  { iconBg: string; iconFg: string; label: string }
> = {
  approval: {
    iconBg: "bg-amber-200 dark:bg-amber-900/60",
    iconFg: "text-amber-800 dark:text-amber-300",
    label: "text-amber-800 dark:text-amber-300",
  },
  question: {
    iconBg: "bg-blue-200 dark:bg-blue-900/60",
    iconFg: "text-blue-800 dark:text-blue-300",
    label: "text-blue-800 dark:text-blue-300",
  },
  credential_request: {
    iconBg: "bg-violet-200 dark:bg-violet-900/60",
    iconFg: "text-violet-800 dark:text-violet-300",
    label: "text-violet-800 dark:text-violet-300",
  },
};
