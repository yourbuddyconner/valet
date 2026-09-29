import { AutomationReview } from "~/components/events/automation-review";
/**
 * TriggerDialog — create or edit a schedule or event trigger.
 *
 * Create: shows a kind picker (Schedule | Event). Edit: kind is locked to
 * `editing.kind` (immutable server-side).
 *
 * Schedule fields: name, cron, timezone (default: local), target radio
 * (workflow | orchestrator), workflow select (hidden when `workflowId` prop
 * set), prompt textarea (orchestrator target), input JSON textarea (workflow
 * target).
 *
 * Event fields: name, workflow select (same hide rule), event key select
 * (from useTriggerCatalog), filters JSON textarea.
 *
 * Edit sends only changed fields (partial update). Create sends all fields.
 * Server errors are rendered verbatim — server messages carry the corrective
 * action (e.g. "Use 5 fields, for example '0 9 * * 1-5'").
 */
import { useState, useEffect } from "react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import { apiErrorMessage } from "~/api/policies";
import {
  useCreateEventTrigger,
  useCreateSchedule,
  useTriggerCatalog,
  useUpdateEventTrigger,
  useUpdateSchedule,
  useWorkflows,
} from "~/api/workflows";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Textarea,
} from "~/components/primitives";
import {
  FilterEditor,
  fromWireFilters,
  incompleteFilterRow,
  pruneFilterRows,
  sameWireFilters,
  toWireFilters,
  type UiFilterRow,
} from "~/components/events/filter-editor";
import {
  hasChannelScopeFilter,
  storedAnyChannel,
  SLACK_APP_MENTION,
} from "~/lib/slack-mention";

type TriggerKind = "schedule" | "event";
type TargetKind = "workflow" | "orchestrator";

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function TriggerDialog({
  open,
  onOpenChange,
  workflowId,
  editing,
  schedulesOnly = false,
  review = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workflowId?: string;
  editing?: WorkflowTriggerItem;
  schedulesOnly?: boolean;
  review?: boolean;
}) {
  const isEditing = editing !== undefined;
  const lockedKind: TriggerKind | undefined = editing?.kind ?? (schedulesOnly ? "schedule" : undefined);

  // ── kind picker ────────────────────────────────────────────────────────
  const [kind, setKind] = useState<TriggerKind>(lockedKind ?? "schedule");

  // ── shared fields ──────────────────────────────────────────────────────
  const [name, setName] = useState("");

  // ── schedule fields ────────────────────────────────────────────────────
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [targetKind, setTargetKind] = useState<TargetKind>("workflow");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(workflowId ?? "");
  const [prompt, setPrompt] = useState("");
  const [inputJson, setInputJson] = useState("");
  const [inputJsonError, setInputJsonError] = useState<string | null>(null);

  // ── event fields ───────────────────────────────────────────────────────
  const [eventKey, setEventKey] = useState("");
  const [filterRows, setFilterRows] = useState<UiFilterRow[]>([]);
  // Explicit opt-out of the channel requirement on a `slack.app_mention`
  // trigger (TKAI-299). Off by default; only rendered for that event.
  const [anyChannel, setAnyChannel] = useState(false);

  // ── form error (client-side validation) ────────────────────────────────
  const [formError, setFormError] = useState<string | null>(null);

  // ── server error ───────────────────────────────────────────────────────
  const [serverError, setServerError] = useState<string | null>(null);

  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const createEvent = useCreateEventTrigger();
  const updateEvent = useUpdateEventTrigger();
  const workflowsQ = useWorkflows();
  const catalogQ = useTriggerCatalog();

  // Flatten catalog entries to a single list for the event key select. Keep
  // each entry's filter fields so the Filters box can show which fields the
  // selected event actually declares.
  const catalogEntries = (catalogQ.data?.catalog ?? []).flatMap((svc) =>
    svc.entries.map((e) => ({ key: e.key, label: e.description, filters: e.filters, readiness: svc.readiness })),
  );
  const selectedEntry = catalogEntries.find((e) => e.key === eventKey);
  const missingSetup = kind === "event" && selectedEntry?.readiness?.ready === false;

  // Populate fields when editing.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
      setFormError(null);
      setServerError(null);
      if (editing.kind === "schedule") {
        setCron(editing.detail.cron);
        setTimezone(editing.detail.timezone);
        setTargetKind(editing.detail.targetKind);
        setSelectedWorkflowId(editing.workflowId ?? workflowId ?? "");
        setPrompt(editing.detail.prompt ?? "");
        setInputJson(
          editing.detail.input != null ? JSON.stringify(editing.detail.input, null, 2) : "",
        );
      } else {
        setEventKey(editing.detail.eventKeys[0] ?? "");
        setFilterRows(fromWireFilters(editing.detail.filters));
        setAnyChannel(storedAnyChannel(editing.detail.eventKeys, editing.detail.filters));
        setSelectedWorkflowId(editing.workflowId ?? workflowId ?? "");
      }
    } else {
      // Reset for create.
      setKind(lockedKind ?? "schedule");
      setName("");
      setCron("");
      setTimezone(defaultTimezone());
      setTargetKind("workflow");
      setSelectedWorkflowId(workflowId ?? "");
      setPrompt("");
      setInputJson("");
      setInputJsonError(null);
      setEventKey("");
      setFilterRows([]);
      setAnyChannel(false);
      setFormError(null);
      setServerError(null);
    }
  }, [open, editing, workflowId, lockedKind]);

  /** Parse a JSON textarea. Empty input returns undefined (the caller picks
   * the default); a parse failure sets the field error and returns null. */
  function parseJson(
    raw: string,
    setError: (msg: string | null) => void,
    errorMessage = 'Input must be valid JSON, for example {"env": "prod"}',
  ): unknown {
    if (!raw.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      setError(null);
      return parsed;
    } catch {
      setError(errorMessage);
      return null;
    }
  }

  const workflows = workflowsQ.data?.workflows ?? [];
  const isPending =
    createSchedule.isPending ||
    updateSchedule.isPending ||
    createEvent.isPending ||
    updateEvent.isPending;

  async function submit() {
    setServerError(null);
    setFormError(null);
    setInputJsonError(null);
    if (missingSetup) {
      setFormError(selectedEntry?.readiness?.reason ?? "Ask an organization admin to connect this event source.");
      return;
    }

    // Client-side: require a workflow selection on create when the workflowId
    // prop is absent and a workflow target is needed.
    if (!isEditing) {
      const needsWorkflow =
        (kind === "schedule" && targetKind === "workflow") || kind === "event";
      if (needsWorkflow && !workflowId && !selectedWorkflowId) {
        setFormError("Select a workflow.");
        return;
      }
    }

    try {
      if (kind === "schedule") {
        // Parse input JSON if present.
        let parsedInput: unknown | undefined;
        if (inputJson.trim()) {
          const result = parseJson(inputJson, setInputJsonError);
          if (result === null) return;
          // Schedule input can be any JSON value; we pass it as-is.
          parsedInput = result;
        }

        if (isEditing) {
          // Send only changed fields.
          // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
          const orig = editing as Extract<WorkflowTriggerItem, { kind: "schedule" }>;
          type ScheduleUpdate = {
            enabled?: boolean;
            name?: string;
            cron?: string;
            timezone?: string;
            prompt?: string;
            input?: unknown;
          };
          const body: ScheduleUpdate = review && !orig.enabled ? { enabled: true } : {};
          if (name !== orig.name) body.name = name;
          if (cron !== orig.detail.cron) body.cron = cron;
          if (timezone !== orig.detail.timezone) body.timezone = timezone;
          if (orig.detail.targetKind === "orchestrator" && prompt !== (orig.detail.prompt ?? "")) {
            body.prompt = prompt;
          }
          if (orig.detail.targetKind === "workflow") {
            if (parsedInput !== undefined) {
              body.input = parsedInput;
            } else if (!inputJson.trim() && orig.detail.input != null) {
              // Emptied the textarea on edit — clear the stored input.
              body.input = null;
            }
          }
          await updateSchedule.mutateAsync({ id: orig.id, body });
        } else {
          const base = { name, cron, timezone };
          if (targetKind === "orchestrator") {
            await createSchedule.mutateAsync({
              ...base,
              target: { kind: "orchestrator", prompt },
            });
          } else {
            const wfId = workflowId ?? selectedWorkflowId;
            const target: { kind: "workflow"; workflowId: string; input?: unknown } = {
              kind: "workflow",
              workflowId: wfId,
            };
            if (parsedInput !== undefined) target.input = parsedInput;
            await createSchedule.mutateAsync({ ...base, target });
          }
        }
      } else {
        // Event trigger.
        const incomplete = incompleteFilterRow(filterRows);
        if (incomplete) {
          setFormError(`Enter a value for the "${incomplete}" filter, or remove the row.`);
          return;
        }
        const filters = toWireFilters(filterRows);
        // Mirror the server's mention channel rules (TKAI-299) so the form
        // names the gap before a round trip — both the missing-channel case
        // and the contradictory pair the server refuses outright.
        if (eventKey === SLACK_APP_MENTION && !anyChannel && !hasChannelScopeFilter(filters)) {
          setFormError(
            'A mention trigger needs a channel filter (equals, or is one of). Add one, or check "Any channel".',
          );
          return;
        }
        if (eventKey === SLACK_APP_MENTION && anyChannel && hasChannelScopeFilter(filters)) {
          setFormError(
            '"Any channel" removes the channel restriction. Remove the channel filters, or turn "Any channel" off.',
          );
          return;
        }

        if (isEditing) {
          // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
          const orig = editing as Extract<WorkflowTriggerItem, { kind: "event" }>;
          type EventUpdate = {
            enabled?: boolean;
            name?: string;
            eventKeys?: string[];
            filters?: unknown[];
            anyChannel?: boolean;
          };
          const body: EventUpdate = review && !orig.enabled ? { enabled: true } : {};
          if (name !== orig.name) body.name = name;
          if (eventKey !== (orig.detail.eventKeys[0] ?? "")) {
            body.eventKeys = [eventKey];
          }
          // Filters are what the rows say now. Send them only when they differ
          // from what was stored, including an empty set that clears them.
          // `sameWireFilters`, not raw JSON compare: stored jsonb reorders
          // keys, and a raw compare would re-send filters on every rename —
          // re-running the mention gate, which 400s a plain rename after the
          // creator unlinks Slack.
          if (!sameWireFilters(filters, orig.detail.filters)) {
            body.filters = filters;
          }
          // A toggle of "Any channel" alone must still produce a write, or
          // the save is a silent no-op — send the (unchanged) filters so the
          // server re-runs the mention gate against the new flag.
          if (
            eventKey === SLACK_APP_MENTION &&
            anyChannel !== storedAnyChannel(orig.detail.eventKeys, orig.detail.filters) &&
            body.filters === undefined
          ) {
            body.filters = filters;
          }
          // The server re-checks mention scoping when the match changes, so
          // the opt-out must ride along then.
          if (
            (body.filters !== undefined || body.eventKeys !== undefined) &&
            eventKey === SLACK_APP_MENTION &&
            anyChannel
          ) {
            body.anyChannel = true;
          }
          await updateEvent.mutateAsync({ id: orig.id, body });
        } else {
          const wfId = workflowId ?? selectedWorkflowId;
          await createEvent.mutateAsync({
            workflowId: wfId,
            name,
            eventKeys: [eventKey],
            filters,
            ...(eventKey === SLACK_APP_MENTION && anyChannel ? { anyChannel: true } : {}),
          });
        }
      }

      onOpenChange(false);
    } catch (err) {
      setServerError(apiErrorMessage(err));
    }
  }

  const title = isEditing ? `Edit ${editing.name}` : schedulesOnly ? "New schedule" : "New trigger";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={review ? "Review the configuration before enabling it." : "Set when this automation runs and what it does."} className="max-w-2xl">
        <div className="grid gap-4">
          {/* Kind picker — only shown when creating */}
          {!lockedKind && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={kind === "schedule" ? "primary" : "ghost"}
                size="sm"
                onClick={() => setKind("schedule")}
              >
                Schedule
              </Button>
              <Button
                variant={kind === "event" ? "primary" : "ghost"}
                size="sm"
                onClick={() => setKind("event")}
              >
                Event
              </Button>
            </div>
          )}

          {/* Name */}
          <div className="grid gap-1">
            <Label htmlFor="trigger-name">Name</Label>
            <Input
              id="trigger-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My trigger"
            />
          </div>

          {kind === "schedule" && (
            <>
              {/* Cron */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-cron">Cron</Label>
                <Input
                  id="trigger-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * 1-5"
                />
              </div>

              {/* Timezone */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-timezone">Timezone</Label>
                <Input
                  id="trigger-timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC"
                />
              </div>

              {/* Target radio — locked when editing */}
              {!lockedKind && (
                <fieldset className="grid gap-1">
                  <legend className="text-sm font-medium text-ink">Target</legend>
                  <div className="flex flex-wrap gap-x-4 pt-1">
                    <label htmlFor="target-workflow" className="flex min-h-11 items-center gap-1.5 text-sm sm:min-h-0">
                      <input
                        id="target-workflow"
                        type="radio"
                        name="trigger-target"
                        value="workflow"
                        checked={targetKind === "workflow"}
                        onChange={() => setTargetKind("workflow")}
                        aria-label="workflow"
                      />
                      Workflow
                    </label>
                    <label
                      htmlFor="target-orchestrator"
                      className="flex min-h-11 items-center gap-1.5 text-sm sm:min-h-0"
                    >
                      <input
                        id="target-orchestrator"
                        type="radio"
                        name="trigger-target"
                        value="orchestrator"
                        checked={targetKind === "orchestrator"}
                        onChange={() => setTargetKind("orchestrator")}
                        aria-label="orchestrator"
                      />
                      Orchestrator
                    </label>
                  </div>
                </fieldset>
              )}

              {/* Workflow select — hidden when workflowId prop is set */}
              {!workflowId && targetKind === "workflow" && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-workflow">Workflow</Label>
                  <select
                    id="trigger-workflow"
                    value={selectedWorkflowId}
                    onChange={(e) => setSelectedWorkflowId(e.target.value)}
                    disabled={isEditing}
                    className="w-full min-w-0 truncate min-h-11 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink sm:min-h-0"
                  >
                    <option value="">— select workflow —</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Prompt textarea — orchestrator target */}
              {(targetKind === "orchestrator" ||
                (isEditing &&
                  // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
                  (editing as Extract<WorkflowTriggerItem, { kind: "schedule" }>).detail
                    .targetKind === "orchestrator")) && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-prompt">Prompt</Label>
                  <Textarea
                    id="trigger-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder="Summarize overnight changes"
                  />
                </div>
              )}

              {/* Input JSON textarea — workflow target */}
              {(targetKind === "workflow" ||
                (isEditing &&
                  // editing.kind matches `kind` (set in the open-reset effect); TS can't narrow through useState
                  (editing as Extract<WorkflowTriggerItem, { kind: "schedule" }>).detail
                    .targetKind === "workflow")) && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-input">Input (JSON)</Label>
                  <Textarea
                    id="trigger-input"
                    value={inputJson}
                    onChange={(e) => setInputJson(e.target.value)}
                    rows={8}
                    placeholder='{"env": "prod"}'
                    className="font-mono"
                  />
                  {inputJsonError && (
                    <div className="text-xs text-danger-500">{inputJsonError}</div>
                  )}
                </div>
              )}
            </>
          )}

          {kind === "event" && (
            <>
              {/* Workflow select — hidden when workflowId prop is set */}
              {!workflowId && (
                <div className="grid gap-1">
                  <Label htmlFor="trigger-event-workflow">Workflow</Label>
                  <select
                    id="trigger-event-workflow"
                    value={selectedWorkflowId}
                    onChange={(e) => setSelectedWorkflowId(e.target.value)}
                    disabled={isEditing}
                    className="w-full min-w-0 truncate min-h-11 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink sm:min-h-0"
                  >
                    <option value="">— select workflow —</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  {workflows.length === 0 && (
                    <p className="text-xs text-muted">
                      You have no workflows yet — create one on the Workflows page to use as a target.
                    </p>
                  )}
                </div>
              )}

              {/* Event key select — from useTriggerCatalog() */}
              <div className="grid gap-1">
                <Label htmlFor="trigger-event-key">Event</Label>
                <p className="text-xs text-muted">Run when an event arrives. Actions are configured inside the workflow.</p>
                <select
                  id="trigger-event-key"
                  value={eventKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setEventKey(key);
                    // Drop filters that the newly-selected event does not
                    // declare, so a leftover filter cannot 400 on submit.
                    const entry = catalogEntries.find((c) => c.key === key);
                    setFilterRows((rows) => pruneFilterRows(rows, entry?.filters ?? []));
                  }}
                  className="w-full min-w-0 truncate min-h-11 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink sm:min-h-0"
                >
                  <option value="">— select event —</option>
                  {catalogEntries.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                {catalogQ.isLoading && <p className="text-xs text-muted">Loading events…</p>}
                {catalogQ.error != null && (
                  <p className="text-xs text-danger-500">Failed to load the event catalog.</p>
                )}
              </div>

              {/* Filters — field/op/value rows from the event catalog */}
              {eventKey.startsWith("linear.") && <p className="text-xs text-muted">
                {missingSetup ? selectedEntry?.readiness?.reason : "Requires the organization’s Linear event connection. Personal tool access is separate."}{" "}
                <a className="underline" href="/settings/organization/linear">Linear event setup</a>
              </p>}
              <div className="grid gap-1.5">
                <Label>Filters</Label>
                {selectedEntry ? (
                  <>
                    <FilterEditor fields={selectedEntry.filters} rows={filterRows} onChange={setFilterRows} />
                    <p className="text-xs text-muted">
                      A trigger fires only when every filter matches. Add none to match every event of this type.
                    </p>
                    {/* Mention scoping (TKAI-299): the server requires a
                        channel filter on this event unless the explicit
                        opt-out is set, and pins the rule to your own
                        @-mentions either way. */}
                    {selectedEntry.key === SLACK_APP_MENTION && (
                      <label className="flex items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={anyChannel}
                          onChange={(e) => setAnyChannel(e.target.checked)}
                        />
                        <span>
                          Any channel
                          <span className="block text-xs text-muted">
                            A mention trigger fires only for your own @-mentions and needs a
                            channel filter. Check this to listen in every channel the app can see
                            instead.
                          </span>
                        </span>
                      </label>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted">Select an event to add filters.</p>
                )}
              </div>
            </>
          )}

          {/* Form validation error */}
          <AutomationReview workflowId={targetKind === "workflow" ? selectedWorkflowId || workflowId : undefined} when={kind === "schedule" ? `${cron} (${timezone})` : eventKey}
            scope={kind === "schedule" ? "This workspace" : filterRows.map(row => `${row.field} ${row.op} ${row.label || row.value}`).join("; ") || "All matching events"}
            result={targetKind === "orchestrator" ? prompt : "Run the workflow with its configured steps and inputs"}
            destination={targetKind === "orchestrator" ? "Workspace assistant, in a scheduled thread" : workflows.find(w => w.id === selectedWorkflowId)?.name || selectedWorkflowId || workflowId}
          />
          {formError && (
            <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
              {formError}
            </div>
          )}

          {/* Server error */}
          {serverError && (
            <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={isPending || missingSetup}>
            {isPending ? (isEditing ? "Saving…" : "Creating…") : review && editing && !editing.enabled ? "Enable automation" : isEditing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
