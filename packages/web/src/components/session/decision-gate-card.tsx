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
import { Button, Spinner, Textarea } from "~/components/primitives";
import { useResolveDecision, useWithdrawDecision } from "~/api/queries";
import { cn } from "~/lib/cn";

export function DecisionGateCard({
  sessionId,
  gate,
}: {
  sessionId: string;
  gate: DecisionGate;
}) {
  const resolve = useResolveDecision(sessionId);
  const withdraw = useWithdrawDecision(sessionId);
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
          className="text-[--muted] hover:text-[--fg] disabled:opacity-50 -mr-1 mt-0.5"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {gate.body && (
        <div className="px-3.5 pb-2 text-xs text-[--muted] whitespace-pre-wrap">
          {gate.body}
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
          {gate.actions.map((a) => (
            <Button
              key={a.id}
              onClick={() => pickAction(a.id)}
              disabled={busy}
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
          ))}
        </div>
      )}
    </div>
  );
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
