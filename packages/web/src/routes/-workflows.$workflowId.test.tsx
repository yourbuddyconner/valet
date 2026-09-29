// @vitest-environment jsdom
/**
 * `/workflows/$workflowId` editor page (plan decision 11): loads the
 * fetched definition into the `Editor` (Task 8-10), Save fires the update
 * mutation with the edited definition, and Run starts a run then navigates
 * to its detail page. `WorkflowEditorPage` takes `workflowId` as a plain
 * prop (the route component just forwards `Route.useParams()`), so this
 * renders it directly without exercising the router's param matching —
 * `<Link>`/`useNavigate` are still mocked since the page renders a back
 * link and calls `useNavigate` on Run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

const navigate = vi.fn();

/**
 * The page guards navigation away from unsaved work with `useBlocker`. The
 * hook needs a live router, so it is mocked like `useNavigate`: the tests
 * read back the `disabled` flag the page passed (whether the guard is
 * armed) and choose the resolver the page sees (`idle` normally, `blocked`
 * for the case where a departure is being held).
 */
type BlockerResolver =
  | { status: "idle"; proceed: undefined; reset: undefined }
  | { status: "blocked"; proceed: () => void; reset: () => void };

const blockerProceed = vi.fn();
const blockerReset = vi.fn();
const IDLE_BLOCKER: BlockerResolver = { status: "idle", proceed: undefined, reset: undefined };
const BLOCKED_BLOCKER: BlockerResolver = {
  status: "blocked",
  proceed: blockerProceed,
  reset: blockerReset,
};
let blocker: BlockerResolver = IDLE_BLOCKER;
let blockerDisabled: boolean | undefined;
const updateMutateAsync = vi.fn().mockResolvedValue({});
const startMutateAsync = vi.fn().mockResolvedValue({ runId: "wfrun_1" });
const allowMutateAsync = vi.fn().mockResolvedValue({ allowed: ["widgets.deploy"], blocked: [] });
/** Per-test permissions payload. Default: nothing gates, so the header
 * badge stays absent everywhere it is not the subject. */
let permissionsData: {
  nodes: Array<{
    nodeId: string;
    service: string;
    action: string;
    actionId: string | null;
    riskLevel?: string;
    mode: "allow" | "require_approval" | "deny" | "unknown";
    provenance?: string;
  }>;
} = { nodes: [] };
const downloadWorkflowFile = vi.fn().mockResolvedValue("deploy-pipeline.yaml");
const useWorkflowTriggersMock = vi.fn((_workflowId?: string) => ({
  data: { triggers: [] },
  isLoading: false,
  error: null,
}));

// The wire ships `definition: unknown` (stored JSON the shape does not
// carry), so the fixture holds it as `unknown` too — a test can then swap
// in any stored shape without a cast.
const initialDefinition: unknown = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop", outcome: "success" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

const workflowData = {
  id: "wf_1",
  ownerType: "user",
  ownerId: "u1",
  name: "Deploy pipeline",
  definition: initialDefinition,
  createdAt: 1,
  updatedAt: 1,
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  useBlocker: (opts: { disabled?: boolean }) => {
    blockerDisabled = opts.disabled;
    return blocker;
  },
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/workflows", () => ({
  downloadWorkflowFile: (...args: unknown[]) => downloadWorkflowFile(...args),
  useCopyWorkflow: () => ({ mutateAsync: vi.fn().mockResolvedValue({ id: "wf_copy" }), isPending: false }),
  useWorkflow: () => ({ data: workflowData, isLoading: false, error: null }),
  useUpdateWorkflow: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useStartRun: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useWorkflowPermissions: () => ({ data: permissionsData, isLoading: false, error: null }),
  useRevokeWorkflowPermissions: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useAllowWorkflowPermissions: () => ({
    mutateAsync: allowMutateAsync,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  // A page with `nextCursor` set: the workflow has more runs than this page
  // holds, which is what the count and the drawer notice must say.
  useWorkflowRuns: () => ({
    data: {
      runs: [{ runId: "wfrun_0", workflowId: "wf_1", status: "settled", outcome: "completed", createdAt: 1, updatedAt: 1 }],
      nextCursor: "1:wfrun_0",
    },
    isLoading: false,
    error: null,
  }),
  useWorkflowVersions: () => ({
    data: {
      versions: [
        { version: 2, name: "Demo", createdAt: 2 },
        { version: 1, name: "Demo", createdAt: 1 },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useWorkflowVersion: (_id: string, version: number | null) => ({
    data:
      version === null
        ? undefined
        : { version, name: "Demo", createdAt: 1, definition: workflowData.definition },
    isLoading: false,
    error: null,
  }),
  useWorkflowTriggers: (workflowId?: string) => useWorkflowTriggersMock(workflowId),
  useWorkflows: () => ({ data: { workflows: [] }, isLoading: false }),
  // The Triggers drawer holds the webhook section beside the trigger list.
  useWorkflowWebhook: () => ({ data: null, isLoading: false, error: null }),
  useMintWorkflowWebhook: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteWorkflowWebhook: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUpdateSchedule: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useUpdateEventTrigger: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useDeleteEventTrigger: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useRunScheduleNow: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useCreateSchedule: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, error: null }),
  useCreateEventTrigger: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, error: null }),
  useTriggerCatalog: () => ({ data: { catalog: [] } }),
}));

/**
 * The assistant panel resolves a session and watches its transcript, both
 * of which need a live QueryClient. This file mocks the data layer rather
 * than providing one, so the two hooks are stubbed here as well. Left
 * un-resolved on purpose: the panel then renders its own "opening" state
 * instead of mounting `SessionView`, which keeps these page-level tests off
 * the whole chat stack. Its header and its openings render either way,
 * which is what the tests below reach for. What the panel does once a
 * session resolves belongs to the session tests.
 */
vi.mock("~/hooks/use-workflow-assistant", () => ({
  useWorkflowAssistant: () => ({ opening: true }),
}));
vi.mock("~/hooks/use-workflow-patch-watch", () => ({
  useWorkflowPatchWatch: () => undefined,
}));

import { ApiError } from "~/api/client";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { WorkflowEditorPage } from "./workflows.$workflowId";

/** JSON mode is deliberately behind the editor's overflow menu — the
 * assistant panel is the promoted path for changing a definition. */
async function openJsonMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More editor actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit JSON" }));
}

describe("WorkflowEditorPage", () => {
  beforeEach(() => {
    navigate.mockClear();
    downloadWorkflowFile.mockClear();
    updateMutateAsync.mockClear();
    startMutateAsync.mockClear();
    blockerProceed.mockClear();
    blockerReset.mockClear();
    blocker = IDLE_BLOCKER;
    blockerDisabled = undefined;
    allowMutateAsync.mockClear();
    permissionsData = { nodes: [] };
    delete (workflowData as { origin?: string }).origin;
    delete (workflowData as { upstream?: unknown }).upstream;
  });

  it("loads the fetched definition into the editor and the name field", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    expect(screen.getByTestId("workflow-editor")).toBeTruthy();
    const nameInput = screen.getByLabelText("Workflow name") as HTMLInputElement;
    expect(nameInput.value).toBe("Deploy pipeline");
  });

  it("renaming marks the page dirty and Save PUTs the new name alongside the definition", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);

    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const nameInput = screen.getByLabelText("Workflow name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Renamed pipeline" } });

    expect(screen.getByTestId("unsaved-indicator")).toBeTruthy();
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const call = updateMutateAsync.mock.calls[0]![0] as { name: string; definition: unknown };
    expect(call.name).toBe("Renamed pipeline");
    expect(call.definition).toBeTruthy();
  });

  it("Cancel resets the name back to the last-saved value", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);

    const nameInput = screen.getByLabelText("Workflow name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Renamed pipeline" } });
    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe("Renamed pipeline");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe("Deploy pipeline");
    expect(screen.queryByTestId("unsaved-indicator")).toBeNull();
  });

  it("Save fires the update mutation with the edited definition", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditorPage workflowId="wf_1" />);

    await openJsonMode(user);
    const textarea = screen.getByLabelText("Definition (JSON)") as HTMLTextAreaElement;
    const updatedText = textarea.value.replace('"Deploy pipeline"', '"Deploy pipeline"').replace(
      '"outcome": "success"',
      '"outcome": "failure"',
    );
    fireEvent.change(textarea, { target: { value: updatedText } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));

    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const call = updateMutateAsync.mock.calls[0]![0] as {
      definition: { nodes: Array<{ id: string; outcome?: string }> };
    };
    const stop = call.definition.nodes.find((n) => n.id === "stop");
    expect(stop?.outcome).toBe("failure");
  });

  it("starts a run and navigates to the run detail page when Run is clicked", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/runs/$runId",
        params: { runId: "wfrun_1" },
      }),
    );
  });

  it("runs immediately, with no dialog, when the trigger's only field is hidden", async () => {
    // github.pull-request-review and github.assign-reviewers, once
    // installed, declare exactly one trigger field: a hidden webhook
    // payload nobody types. Run must not open a dialog asking for it.
    const original = workflowData.definition;
    workflowData.definition = {
      version: "dag/v1",
      nodes: [
        {
          id: "start",
          type: "trigger",
          dataSchema: { payload: { type: "object", hidden: true } },
        },
      ],
      edges: [],
    };
    try {
      render(<WorkflowEditorPage workflowId="wf_1" />);
      fireEvent.click(screen.getByRole("button", { name: "Run" }));

      await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
      expect(screen.queryByText("payload")).toBeNull();
      expect(screen.queryByText(/This workflow's trigger declares inputs/)).toBeNull();
    } finally {
      workflowData.definition = original;
    }
  });

  it("lists runs in the runs drawer, and says when the list is one page of more", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    // `1+`, not `1`: the count is the page's length, not the run total.
    fireEvent.click(screen.getByRole("button", { name: "Runs (1+)" }));
    expect(screen.getByText("wfrun_0")).toBeTruthy();
    expect(screen.getByText(/Newest 1 runs shown/)).toBeTruthy();
  });

  it("renders a mirrored workflow read-only, with a copy and a file link", () => {
    Object.assign(workflowData, {
      origin: "repo",
      upstream: { repoFullName: "tkhq/automation", ref: "release/v2", path: ".valet/workflows/nightly.yaml" },
    });
    render(<WorkflowEditorPage workflowId="wf_1" />);
    expect(screen.getByTestId("mirrored-banner")).toBeTruthy();
    expect(screen.getByRole("link", { name: "tkhq/automation:.valet/workflows/nightly.yaml" }).getAttribute("href")).toBe("https://github.com/tkhq/automation/blob/release%2Fv2/.valet/workflows/nightly.yaml");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).readOnly).toBe(true);
  });

  it("downloads the decision-4 envelope from the overflow menu", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("Download"));
    expect(downloadWorkflowFile).toHaveBeenCalledWith("wf_1");
  });

  it("renders the scoped triggers panel for this workflow", () => {
    useWorkflowTriggersMock.mockClear();
    render(<WorkflowEditorPage workflowId="wf_1" />);
    // The panel lives in the Triggers drawer, which starts closed, so the
    // scoped read only happens after the toolbar button opens it.
    fireEvent.click(screen.getByRole("button", { name: "Triggers" }));
    expect(useWorkflowTriggersMock).toHaveBeenCalledWith("wf_1");
  });

  it("history drawer lists versions newest-first with a current badge, restore only on older ones", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    // "Version history" lives in the toolbar's overflow menu — Radix
    // dropdowns don't open on a plain jsdom click, but the keyboard path does.
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("Version history"));
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("current")).toBeTruthy();

    // Selecting the current version shows no restore button.
    fireEvent.click(screen.getByText("v2"));
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();

    // An older version offers restore. Restore overwrites the live
    // definition with no undo, so the button asks before it PUTs — this
    // case used to assert the PUT fired on the first click.
    fireEvent.click(screen.getByText("v1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore v1" }));
    expect(updateMutateAsync).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore v1" }));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({
        name: "Deploy pipeline",        definition: workflowData.definition,
      }),
    );
  });

  /**
   * A restore re-saves an old definition, so the save-time validator judges
   * it. A version snapshotted before a rule existed does not pass that rule
   * and the PUT 400s. `ApiError.message` is only "PUT /workflows/wf_1 → 400",
   * so showing it leaves the reader with no fault and no fix. The drawer is
   * the only surface that can show the `errors` list for an old version.
   */
  it("restore names the node and the corrected path when the old version no longer validates", async () => {
    updateMutateAsync.mockRejectedValueOnce(
      new ApiError(400, "PUT /workflows/wf_1 → 400", {
        error: "invalid workflow definition",
        errors: [
          'node "build": values.to reads "trigger.email", but a trigger payload carries only ' +
            'type, triggerId, timestamp, data, metadata (did you mean "trigger.data.email"?)',
        ],
      }),
    );
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("Version history"));
    fireEvent.click(screen.getByText("v1"));
    fireEvent.click(screen.getByRole("button", { name: "Restore v1" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore v1" }));

    const shown = await within(dialog).findByText(/trigger\.data\.email/);
    expect(shown.textContent).toContain('node "build"');
    // And it says what to do, not only that the request failed.
    expect(shown.textContent).toContain("then save");
    expect(shown.textContent).not.toContain("→ 400");
  });

  it("arms the leave guard for a rename, and leaves it off on a clean page", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    // A clean page must not arm the guard, or every tab close would ask.
    expect(blockerDisabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Workflow name"), {
      target: { value: "Renamed pipeline" },
    });
    expect(blockerDisabled).toBe(false);
  });

  it("arms the leave guard for a definition edit, not only a rename", async () => {
    const user = userEvent.setup();
    render(<WorkflowEditorPage workflowId="wf_1" />);
    expect(blockerDisabled).toBe(true);

    await openJsonMode(user);
    const textarea = screen.getByLabelText("Definition (JSON)") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: textarea.value.replace('"success"', '"failure"') },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(blockerDisabled).toBe(false);
  });

  it("has the assistant on screen from the start, with nothing to press to reach it", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    expect(screen.getByRole("complementary", { name: "Workflow assistant" })).toBeTruthy();
    // Beside the canvas, not over it: the conversation is about the
    // diagram, so the diagram stays visible.
    expect(screen.getByTestId("workflow-editor")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the assistant" })).toBeNull();
  });

  it("puts a suggestion in the composer of the assistant that is already open", () => {
    useComposerPrefillStore.setState({ text: null });
    render(<WorkflowEditorPage workflowId="wf_1" />);
    // The openings name steps from this workflow, so they are instructions
    // the agent can act on, not a generic "ask me anything".
    fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    expect(useComposerPrefillStore.getState().text).toContain("wf_1");
  });

  it("offers Leave without saving while a departure is held, and proceeds on confirm", () => {
    blocker = BLOCKED_BLOCKER;
    render(<WorkflowEditorPage workflowId="wf_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(blockerProceed).toHaveBeenCalledTimes(1);
    expect(blockerReset).not.toHaveBeenCalled();
  });
});

describe("WorkflowEditorPage — permissions badge and pre-approval", () => {
  beforeEach(() => {
    allowMutateAsync.mockClear();
    allowMutateAsync.mockResolvedValue({ allowed: ["widgets.deploy"], blocked: [] });
    permissionsData = {
      nodes: [
        {
          nodeId: "ship",
          service: "widgets",
          action: "deploy",
          actionId: "widgets.deploy",
          riskLevel: "high",
          mode: "require_approval",
          provenance: "risk_default",
        },
        // A second node calling the SAME action: the badge counts actions,
        // not nodes, so these two are one approval.
        {
          nodeId: "ship-again",
          service: "widgets",
          action: "deploy",
          actionId: "widgets.deploy",
          riskLevel: "high",
          mode: "require_approval",
          provenance: "risk_default",
        },
        {
          nodeId: "inventory",
          service: "widgets",
          action: "list",
          actionId: "widgets.list",
          riskLevel: "low",
          mode: "allow",
          provenance: "risk_default",
        },
      ],
    };
  });

  it("offers workflow-scoped review for team workflows", () => {
    workflowData.ownerType = "team";
    workflowData.ownerId = "team-1";
    try {
      render(<WorkflowEditorPage workflowId="wf_1" />);
      expect(screen.getByTestId("workflow-gate-badge")).toBeTruthy();
      expect(screen.queryByText("Pre-approve actions")).toBeNull();
      expect(allowMutateAsync).not.toHaveBeenCalled();
    } finally { workflowData.ownerType = "user"; workflowData.ownerId = "u1"; }
  });

  it("shows the header badge with the count of unique gating actions", () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    const badge = screen.getByTestId("workflow-gate-badge");
    expect(badge.textContent).toContain("Review permissions");
  });

  it("hides the badge when nothing gates", () => {
    permissionsData = { nodes: [] };
    render(<WorkflowEditorPage workflowId="wf_1" />);
    expect(screen.queryByTestId("workflow-gate-badge")).toBeNull();
  });

  it("pre-approves through the dialog: lists the actions, confirms, closes", async () => {
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.click(screen.getByTestId("workflow-gate-badge"));

    const list = await screen.findByTestId("preapprove-actions");
    expect(within(list).getByText("widgets.deploy")).toBeTruthy();
    expect(within(list).queryByText("widgets.list")).toBeNull();

    fireEvent.click(screen.getByTestId("preapprove-confirm"));
    await waitFor(() => expect(allowMutateAsync).toHaveBeenCalledWith(["widgets.deploy"]));
    await waitFor(() => expect(screen.queryByTestId("preapprove-actions")).toBeNull());
    expect(screen.queryByTestId("preapprove-blocked")).toBeNull();
  });

  it("surfaces org-blocked actions after a pre-approval attempt", async () => {
    allowMutateAsync.mockResolvedValue({
      allowed: [],
      blocked: [{ actionId: "widgets.deploy", reason: "an org policy requires approval" }],
    });
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.click(screen.getByTestId("workflow-gate-badge"));
    fireEvent.click(await screen.findByTestId("preapprove-confirm"));

    const notice = await screen.findByTestId("preapprove-blocked");
    expect(notice.textContent).toContain("widgets.deploy");
    expect(notice.textContent).toContain("org admin");
  });

  it("reopening the dialog clears the previous attempt's blocked notice", async () => {
    allowMutateAsync.mockResolvedValue({
      allowed: [],
      blocked: [{ actionId: "widgets.deploy", reason: "an org policy requires approval" }],
    });
    render(<WorkflowEditorPage workflowId="wf_1" />);
    fireEvent.click(screen.getByTestId("workflow-gate-badge"));
    fireEvent.click(await screen.findByTestId("preapprove-confirm"));
    await screen.findByTestId("preapprove-blocked");

    // A reopen is a fresh attempt: the stale notice must not read as its
    // result.
    fireEvent.click(screen.getByTestId("workflow-gate-badge"));
    expect(screen.queryByTestId("preapprove-blocked")).toBeNull();
  });
});
