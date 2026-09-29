/**
 * Editor composition (plan decision 10 / Task 10): owns the
 * `WorkflowDefinition` state and wires the palette, canvas, inspector, and
 * validation banner (Tasks 8-10) together. Task 11's route mounts this
 * with `initialDefinition` loaded from `GET /workflows/:id` and `onSave`
 * bound to `useUpdateWorkflow`.
 *
 * There is one column to the right of the canvas, and it belongs to the
 * assistant the page passes in (`assistant`). Selecting a step covers that
 * column with the step's form, which is the hand-editing path — the two
 * ways to change a workflow share one place instead of competing for two.
 *
 * Save semantics (plan decision 10, locked): the Save button is disabled
 * when the definition is invalid OR unchanged since the last save/load —
 * `PUT /workflows/:id` 400s on an invalid definition
 * (`packages/api/src/routes/workflows.ts`), so blocking Save on validation
 * errors here just surfaces that constraint before the round-trip instead
 * of after it. The banner (not Save) is what shows the errors themselves;
 * an invalid definition is otherwise a completely normal in-progress
 * editing state and is never silently discarded.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { validateWorkflowDefinition, type WorkflowDefinition } from "@valet/workflow";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { ApiError } from "~/api/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  Textarea,
} from "~/components/primitives";
import {
  isWorkflowDefinitionShape,
  connect,
  createEdgeId,
  duplicateNode,
  graphSignature,
  positionNewNodes,
  removeNode as removeNodeFromDefinition,
  setNodePosition,
  setViewport,
  toFlow,
  updateEdge,
  updateNode,
  addNode as addNodeToDefinition,
  type AddableDagNodeType,
  type ConnectParams,
  type EdgeMatch,
  type EdgePatch,
  type FlowPosition,
  type FlowViewport,
  type WorkflowFlowEdge,
} from "../editor-model";
import { Canvas } from "./canvas";
import { EdgeInspector } from "./edge-inspector";
import { Inspector } from "./inspector";
import { cn } from "~/lib/cn";
import { CompactPalette, Palette } from "./palette";
import { errorNodeIdsFrom, ValidationBanner } from "./validation-banner";

export interface EditorProps {
  /**
   * The definition as the server currently holds it. It seeds the local
   * draft at mount and backs Cancel, and the editor also ADOPTS it when it
   * changes: the assistant panel edits the stored workflow directly through
   * `workflows.patch_workflow`, and the refetch that follows arrives here.
   * A draft with edits that are not saved is never overwritten — that case
   * raises the conflict bar instead.
   */
  initialDefinition: WorkflowDefinition;
  onSave: (definition: WorkflowDefinition) => Promise<void>;
  saving?: boolean;
  /**
   * The conversation that fills the right-hand column. The editor holds
   * the column and the selection, and the page holds the assistant
   * session, so the page passes the mounted conversation in rather than
   * the editor resolving one for itself. A host with no assistant gets the
   * column back as a plain hint.
   */
  assistant?: ReactNode;
  /**
   * Task 11 review fix: the page owns a rename input outside this
   * component (in the editor page's header, replacing the old read-only
   * h1) and reports its own dirtiness here. Editor folds it into its own
   * dirty/Save/Cancel handling — `externalDirty` ORs into the unsaved
   * indicator and Save-enablement, `onCancelExternal` is called alongside
   * the definition reset — so a rename rides the same Save/Cancel actions
   * as a definition edit without Editor needing to know anything about
   * names.
   */
  externalDirty?: boolean;
  onCancelExternal?: () => void;
  /**
   * Reports whether the definition has edits that are not saved. The
   * definition draft lives here, so the page cannot otherwise tell that
   * leaving would discard work. Pass a state setter (a stable identity),
   * not an inline closure.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** Per-node policy predictions for the canvas cards, keyed by node id.
   * The page owns the query (it is per stored workflow, not per draft). */
  gateByNodeId?: ReadonlyMap<string, "require_approval" | "deny">;
  /** A mirrored workflow is edited in its file. Disable definition changes
   * and hide Save and the JSON hatch. */
  readOnly?: boolean;
}

export function Editor(props: EditorProps) {
  // A change in edit permission starts a fresh draft from the server.
  return <EditorDraft key={String(props.readOnly === true)} {...props} />;
}

function EditorDraft({
  initialDefinition,
  onSave,
  saving,
  assistant,
  externalDirty,
  onCancelExternal,
  onDirtyChange,
  gateByNodeId,
  readOnly = false,
}: EditorProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(initialDefinition);
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [compactView, setCompactView] = useState<"canvas" | "assistant">("canvas");
  const inspectorBackRef = useRef<HTMLButtonElement>(null);
  const canvasViewRef = useRef<HTMLButtonElement>(null);
  const wasInspectingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Raised when the stored definition moved while the user has unsaved
  // edits. Adopting would throw their work away, so the editor asks.
  const [conflict, setConflict] = useState(false);
  // The last `initialDefinition` this editor saw. A CHANGE here is the only
  // evidence the stored definition moved. Comparing the prop against the
  // draft instead would misread the window after a save, where the query
  // still holds the pre-save definition until the refetch lands.
  const lastServerRef = useRef<string>(graphSignature(initialDefinition));
  // What this editor last wrote. The refetch after a save brings it back,
  // and the editor must not treat its own write as somebody else's edit.
  const savedRef = useRef<string | null>(null);

  const effectiveDirty = !readOnly && (dirty || externalDirty === true);

  useEffect(() => {
    onDirtyChange?.(!readOnly && dirty);
  }, [dirty, readOnly, onDirtyChange]);

  /** Replace the draft with the server's definition. */
  const adoptServerDefinition = useCallback((next: WorkflowDefinition) => {
    setDefinition((current) => {
      // `patch_workflow` carries no `ui`, so a node it added has no saved
      // position and would fall back to auto-layout coordinates that can
      // sit on top of a hand-placed node.
      const placed = positionNewNodes(next);
      // Keep the camera. The user did not ask to be moved, and the stored
      // viewport is from whenever the workflow was last saved.
      const viewport = current.ui?.viewport;
      return viewport ? setViewport(placed, viewport) : placed;
    });
    lastServerRef.current = graphSignature(next);
    setDirty(false);
    setConflict(false);
    setSaveError(null);
    // Hold the selection when the step survived the edit; a selection
    // pointing at a removed node would render an inspector for nothing.
    setSelectedNodeId((id) => (id !== null && next.nodes.some((n) => n.id === id) ? id : null));
    setSelectedEdgeId((id) =>
      id !== null &&
      next.edges.some((edge) => createEdgeId(edge.from, edge.to, edge.fromOutput) === id)
        ? id
        : null,
    );
  }, []);

  useEffect(() => {
    const next = graphSignature(initialDefinition);
    if (next === lastServerRef.current) return;
    lastServerRef.current = next;
    // The refetch that follows a save. The draft on screen already IS this
    // definition, so there is nothing to adopt and nobody to warn about.
    if (next === savedRef.current) return;
    // Unsaved work outranks an automatic refresh. The user resolves it with
    // Reload or Cancel, which both adopt, or with Save, which overwrites.
    if (effectiveDirty) {
      setConflict(true);
      return;
    }
    adoptServerDefinition(initialDefinition);
  }, [initialDefinition, effectiveDirty, adoptServerDefinition]);

  const flow = useMemo(() => toFlow(definition), [definition]);
  const validation = useMemo(() => validateWorkflowDefinition(definition), [definition]);
  const errors = validation.ok ? [] : validation.errors;
  const errorNodeIds = useMemo(() => errorNodeIdsFrom(errors), [errors]);

  const selectedNode = selectedNodeId ? definition.nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? flow.edges.find((e) => e.id === selectedEdgeId) ?? null : null;
  const selectedEdgeSourceType = selectedEdge
    ? definition.nodes.find((n) => n.id === selectedEdge.source)?.type
    : undefined;

  function mutate(next: WorkflowDefinition) {
    if (readOnly) return;
    setDefinition(next);
    setDirty(true);
  }

  function handleAddNode(type: AddableDagNodeType) {
    const result = addNodeToDefinition(definition, type);
    mutate(result.definition);
    setSelectedEdgeId(null);
    setSelectedNodeId(result.nodeId);
    setCompactView("canvas");
  }

  function handleNodePositionChange(nodeId: string, position: FlowPosition) {
    mutate(setNodePosition(definition, nodeId, position));
  }

  function handleConnect(params: ConnectParams) {
    const result = connect(definition, params);
    if (result.ok) mutate(result.definition);
  }

  function handleSelectNode(nodeId: string | null) {
    setSelectedNodeId(nodeId);
    if (nodeId) {
      setSelectedEdgeId(null);
      setCompactView("canvas");
    }
  }

  function handleSelectEdge(edgeId: string | null) {
    setSelectedEdgeId(edgeId);
    if (edgeId) {
      setSelectedNodeId(null);
      setCompactView("canvas");
    }
  }

  function handleViewportChange(viewport: FlowViewport) {
    setDefinition((current) => setViewport(current, viewport));
  }

  function handleRemoveNode(nodeId: string) {
    mutate(removeNodeFromDefinition(definition, nodeId));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  }

  function handleRemoveEdge(edgeId: string) {
    mutate({
      ...definition,
      edges: definition.edges.filter((edge) => createEdgeId(edge.from, edge.to, edge.fromOutput) !== edgeId),
    });
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
  }

  function handleDuplicateNode(nodeId: string) {
    const result = duplicateNode(definition, nodeId);
    if (!result) return;
    mutate(result.definition);
    setSelectedNodeId(result.nodeId);
    setCompactView("canvas");
  }

  function handleNodeChange(nodeId: string, patch: Record<string, unknown>) {
    mutate(updateNode(definition, nodeId, patch));
  }

  function handleEdgeChange(edge: WorkflowFlowEdge, patch: EdgePatch) {
    const match: EdgeMatch = { from: edge.source, to: edge.target, fromOutput: edge.data.fromOutput };
    mutate(updateEdge(definition, match, patch));
    // Edge ids encode `fromOutput` (`createEdgeId`), so patching it re-keys
    // the edge in the re-derived flow — carry the selection to the new id
    // rather than leaving it pointed at an id that no longer exists.
    const nextFromOutput = "fromOutput" in patch ? patch.fromOutput : edge.data.fromOutput;
    setSelectedEdgeId(createEdgeId(edge.source, edge.target, nextFromOutput));
  }

  function handleCancel() {
    // Cancel reverts to what the SERVER holds, which may now include an
    // edit the assistant made — so it also clears a conflict.
    adoptServerDefinition(initialDefinition);
    // Cancel drops the whole editing context, selection included. Adopting
    // holds a selection that survived the edit, which is right when the
    // change came from the assistant and wrong when the user asked to
    // start over.
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    onCancelExternal?.();
  }

  async function handleSave() {
    if (readOnly) return;
    setSaveError(null);
    try {
      await onSave(definition);
      // Record what went to the server, so the refetch that follows does
      // not come back looking like an edit from somewhere else.
      savedRef.current = graphSignature(definition);
      setDirty(false);
      setConflict(false);
    } catch (err) {
      setSaveError(saveErrorMessage(err));
    }
  }

  function handleApplyJson(next: WorkflowDefinition) {
    mutate(next);
  }

  function clearSelection() {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }

  function showCanvas() {
    clearSelection();
    setCompactView("canvas");
  }

  function showAssistant() {
    clearSelection();
    setCompactView("assistant");
  }

  const saveDisabled = !effectiveDirty || !validation.ok || saving === true;

  // The form for whatever is selected, or null when nothing is. JSON mode
  // edits the whole definition as text, so a selection made on the canvas
  // before the switch must not put a second editor for one step on screen.
  const inspector = jsonMode ? null : selectedNode ? (
    <Inspector
      readOnly={readOnly}
      key={selectedNode.id}
      node={selectedNode}
      onChange={(patch) => handleNodeChange(selectedNode.id, patch)}
      onRemove={() => handleRemoveNode(selectedNode.id)}
      onDuplicate={() => handleDuplicateNode(selectedNode.id)}
    />
  ) : selectedEdge && selectedEdgeSourceType ? (
    <EdgeInspector
      readOnly={readOnly}
      key={selectedEdge.id}
      edge={selectedEdge}
      sourceNodeType={selectedEdgeSourceType}
      onChange={(patch) => handleEdgeChange(selectedEdge, patch)}
      onRemove={() => handleRemoveEdge(selectedEdge.id)}
    />
  ) : null;

  const inspecting = inspector !== null;
  useEffect(() => {
    // A phone selection hides the focused canvas node. Keep keyboard focus
    // in the visible view without moving it on each field edit.
    const wasInspecting = wasInspectingRef.current;
    wasInspectingRef.current = inspecting;
    if (!window.matchMedia?.("(max-width: 1023px)").matches) return;
    if (inspecting) inspectorBackRef.current?.focus();
    else if (wasInspecting && compactView === "canvas") canvasViewRef.current?.focus();
  }, [inspecting, selectedNodeId, selectedEdgeId, compactView]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="workflow-editor">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          {effectiveDirty && (
            <span
              data-testid="unsaved-indicator"
              title="Unsaved changes"
              className="inline-block h-2 w-2 rounded-full bg-amber"
            />
          )}
          {/* JSON mode is the escape hatch for a change the assistant
              cannot express, so it stays — but out of the way. Reaching it
              takes a menu; leaving it takes one visible button, because
              nobody should have to hunt for the way back to the canvas. */}
          {!readOnly &&
            (jsonMode ? (
              <Button variant="secondary" size="sm" onClick={() => setJsonMode(false)}>
                Visual editor
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" aria-label="More editor actions">
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => { setJsonMode(true); setCompactView("canvas"); }}>Edit JSON</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
        </div>
        {!readOnly && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {saveError && (
              <span role="alert" className="text-xs text-danger-600 dark:text-danger-500">
                {saveError}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={handleCancel} disabled={!effectiveDirty}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saveDisabled}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>

      {conflict && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-amber/40 bg-amber/10 px-3 py-2 text-xs text-ink"
        >
          <span className="min-w-0 flex-1">
            The assistant changed this workflow while you were editing. Your unsaved edits are
            still on screen. To take the assistant’s version instead, select Reload. To keep
            yours and overwrite it, select Save.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => adoptServerDefinition(initialDefinition)}
          >
            Reload
          </Button>
        </div>
      )}

      <ValidationBanner errors={errors} />

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 lg:hidden" aria-label="Editor view">
        <Button
          size="sm"
          variant={compactView === "canvas" ? "secondary" : "ghost"}
          aria-label="Show canvas"
          ref={canvasViewRef}
          aria-pressed={compactView === "canvas"}
          onClick={showCanvas}
        >
          Canvas
        </Button>
        <Button
          size="sm"
          variant={compactView === "assistant" ? "secondary" : "ghost"}
          aria-label="Show assistant"
          aria-pressed={compactView === "assistant"}
          onClick={showAssistant}
        >
          Assistant
        </Button>
        {!jsonMode && <CompactPalette onAdd={handleAddNode} disabled={readOnly} />}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Visibility changes keep the canvas camera and conversation drafts mounted. */}
        <div className={cn(
          "min-h-0 min-w-0 flex-1 lg:flex",
          compactView === "canvas" && !inspector ? "flex" : "hidden",
        )}>
        {jsonMode && !readOnly ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
            <JsonDefinitionEditor definition={definition} onApply={handleApplyJson} />
          </div>
        ) : (
          <>
            <div className="hidden lg:flex"><Palette onAdd={handleAddNode} disabled={readOnly} /></div>
            <div className="min-w-0 flex-1">
              <Canvas
                readOnly={readOnly}
                flow={flow}
                errorNodeIds={errorNodeIds}
                gateByNodeId={gateByNodeId}
                onNodePositionChange={handleNodePositionChange}
                onConnect={handleConnect}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onViewportChange={handleViewportChange}
                onRemoveNode={handleRemoveNode}
                onRemoveEdge={handleRemoveEdge}
              />
            </div>
          </>
        )}
        </div>
        {/* ONE right-hand column, not two. It holds the assistant, and the
            selected step's form takes it over for as long as a step is
            selected. The conversation stays mounted underneath: it owns a
            live session socket and whatever is half-typed in its composer,
            and selecting a step must drop neither. `inert` keeps the
            covered conversation out of the tab order and out of the
            accessibility tree, so only one of the two answers a query. */}
        <div className={cn(
          "relative min-h-0 min-w-0 w-full flex-col bg-paper lg:flex lg:w-[--editor-aside] lg:max-w-full lg:shrink-0 lg:border-l lg:border-line",
          compactView === "assistant" || inspector ? "flex" : "hidden",
        )}>
          <div className="flex min-h-0 flex-1 flex-col" inert={inspector !== null}>
            {assistant ?? (
              <p className="p-3 text-sm text-muted">Select a node or edge to edit its settings.</p>
            )}
          </div>
          {inspector && (
            <div className="absolute inset-0 z-10 flex flex-col bg-paper">
              <div className="border-b border-line px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSelection}
                  title="Back to the assistant"
                  className="hidden lg:inline-flex"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  Assistant
                </Button>
                <Button ref={inspectorBackRef} variant="ghost" size="sm" className="lg:hidden" onClick={showCanvas}>
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  Back to canvas
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{inspector}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Deliberately not `JsonTextarea` (`fields.tsx`): that component
 * auto-propagates on every valid keystroke, which here would mean typing
 * a definition edit re-derives the whole flow/inspector state mid-edit.
 * The JSON-mode round-trip is edit-then-explicit-"Apply" instead —
 * `text` is local until the button is pressed.
 */
function JsonDefinitionEditor({
  definition,
  onApply,
}: {
  definition: WorkflowDefinition;
  onApply: (definition: WorkflowDefinition) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(definition, null, 2));
  const [error, setError] = useState<string | null>(null);

  function handleApply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      setError(e instanceof Error ? e.message : "invalid JSON");
      return;
    }
    if (!isWorkflowDefinitionShape(parsed)) {
      setError('definition must be an object with "version", "nodes", and "edges"');
      return;
    }
    setError(null);
    onApply(parsed);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="workflow-json-editor">Definition (JSON)</Label>
      <Textarea
        id="workflow-json-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={24}
        className="font-mono text-xs"
        aria-invalid={error !== null}
      />
      {error && (
        <span role="alert" className="text-xs text-danger-600 dark:text-danger-500">
          {error}
        </span>
      )}
      <Button size="sm" onClick={handleApply}>
        Apply
      </Button>
    </div>
  );
}

/**
 * `PUT /workflows/:id` 400s on an invalid definition with
 * `{ error, errors: string[] }` (`packages/api/src/routes/workflows.ts`
 * `validateDefinitionInput`). Surface the per-field messages in the
 * save-error line instead of the flattened `ApiError` message so a
 * rejected Save says *what's* invalid, not just that the request failed.
 */
function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const payload = err.payload;
    if (payload && typeof payload === "object") {
      const errs = (payload as Record<string, unknown>).errors;
      if (Array.isArray(errs) && errs.every((e): e is string => typeof e === "string") && errs.length > 0) {
        return errs.join("; ");
      }
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to save workflow.";
}
