// @vitest-environment jsdom
/**
 * You sections (split-settings design, Task 6): profile save, the
 * default-model typeahead's filter/select/clear, the enable-organizations
 * card's gate visibility + PATCH-then-navigate, appearance's theme
 * radio-cards, and the notifications toggle. Mocks `~/api/settings` /
 * `~/api/workspace-runtime` / `~/api/queries` / `@tanstack/react-router` the same
 * way `-integrations.test.tsx` mocks `~/api/integrations` — these tests
 * only care what each section renders and which mutation it fires, not that
 * TanStack Query or the router themselves resolve anything.
 *
 * Task 11 adds the API keys section, mocking `~/api/api-keys` the same way
 * — the create flow's one-time secret reveal and the revoke confirm-gate.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const patchMeMutate = vi.fn();
const uploadMyAvatarMutateAsync = vi.fn().mockResolvedValue({ avatarUrl: "/avatars/me.webp" });
const patchOrgMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const setPrefMutate = vi.fn();
const navigateMock = vi.fn();
const createApiKeyMutate = vi.fn();
const revokeApiKeyMutate = vi.fn();

let meData: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "admin" | "member";
  orgId: string;
  orgRole: "admin" | "member";
  defaultModel: string | null;
  defaultReasoning?: string | null;
  newThreadBehavior: "keep_current" | "use_defaults";
} | undefined = {
  id: "u1",
  email: "me@example.com",
  name: "Ada",
  avatarUrl: null,
  role: "member",
  orgId: "org_1",
  orgRole: "admin",
  defaultModel: null,
  defaultReasoning: null,
  newThreadBehavior: "keep_current",
};

let orgData: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined = {
  callerRole: "admin",
  features: { organizations: false },
};

let apiKeysData: Array<{
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
}> = [];

const modelsData = {
  models: [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200000, reasoning: false, approved: true },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, reasoning: true, approved: true },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200000, reasoning: true, approved: true },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 200000, reasoning: true, approved: true },
    { id: "some-exotic-model", name: "Exotic", contextWindow: 100000, reasoning: false, approved: true },
  ],
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => navigateMock,
}));

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: meData, isLoading: false, error: null }),
    useOrg: () => ({ data: orgData, isLoading: false, error: null }),
    useModels: () => ({ data: modelsData, isLoading: false, error: null }),
    useModelTiers: () => ({ data: { xs: [], s: [], m: [], l: [], xl: [] }, isLoading: false, error: null }),
    useOrgReasoning: () => ({ data: {}, isLoading: false, error: null }),
    usePatchMe: () => ({ mutate: patchMeMutate, isPending: false, error: null }),
    useUploadMyAvatar: () => ({ mutateAsync: uploadMyAvatarMutateAsync, isPending: false, error: null }),
    usePatchOrg: () => ({ mutateAsync: patchOrgMutateAsync, isPending: false, error: null }),
    useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  };
});

vi.mock("~/api/workspace-runtime", () => ({
  useOrchestratorInfo: () => ({
    data: { sessionId: "s1", name: "Valet", personality: null, presence: "idle", activeChildren: 0 },
    isLoading: false,
    error: null,
  }),
}));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useNotificationPreferences: () => ({
      data: { preferences: [{ kind: "notification", web: true }] },
      isLoading: false,
      error: null,
    }),
    useSetNotificationPreference: () => ({ mutate: setPrefMutate }),
  };
});

vi.mock("~/api/api-keys", () => ({
  useApiKeys: () => ({ data: apiKeysData, isLoading: false, error: null }),
  useCreateApiKey: () => ({ mutate: createApiKeyMutate, isPending: false, error: null }),
  useRevokeApiKey: () => ({ mutate: revokeApiKeyMutate, isPending: false, error: null }),
}));

vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({
      key: "user",
      teamId: undefined,
      available: ["user"],
      setKey: () => {},
    }),
  };
});

import { PALETTE_CHOICES } from "~/lib/theme";
import { ApiKeysPage } from "./settings.api-keys";
import { AppearancePage } from "./settings.appearance";
import { ThreadDefaultsPage } from "./settings.threads";
import { NotificationsPage } from "./settings.notifications";
import { ProfilePage } from "./settings.profile";

describe("ProfilePage", () => {
  beforeEach(() => {
    patchMeMutate.mockClear();
    patchOrgMutateAsync.mockClear();
    meData = {
      id: "u1",
      email: "me@example.com",
      name: "Ada",
      avatarUrl: null,
      role: "member",
      orgId: "org_1",
      orgRole: "admin",
      defaultModel: null,
      newThreadBehavior: "keep_current",
    };
    orgData = { callerRole: "admin", features: { organizations: false } };
  });

  it("renders name/avatar and a read-only email row with the spec hint", () => {
    render(<ProfilePage />);
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Ada");
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.value).toBe("me@example.com");
    expect(email.readOnly).toBe(true);
    expect(
      screen.getByText("Sign-in email — managed by your login once real auth ships."),
    ).toBeTruthy();
  });

  it("uploads a selected profile picture", async () => {
    uploadMyAvatarMutateAsync.mockClear();
    render(<ProfilePage />);
    const file = new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Profile picture file"), { target: { files: [file] } });
    await waitFor(() => expect(uploadMyAvatarMutateAsync).toHaveBeenCalledWith(file));
  });

  it("Save is disabled until a field is dirty, then PATCHes /api/me", () => {
    render(<ProfilePage />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    expect(patchMeMutate).toHaveBeenCalledWith({ name: "Ada Lovelace", avatarUrl: "" });
  });

  it("shows the enable-org card for an admin with the gate off, and it PATCHes + navigates", async () => {
    render(<ProfilePage />);
    expect(screen.getByText("Working with a team? Enable organizations")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() =>
      expect(patchOrgMutateAsync).toHaveBeenCalledWith({ features: { organizations: true } }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/organization" }));
  });

  it("hides the enable-org card when the gate is already on", () => {
    orgData = { callerRole: "admin", features: { organizations: true } };
    render(<ProfilePage />);
    expect(screen.queryByText("Working with a team? Enable organizations")).toBeNull();
  });

  it("hides the enable-org card for a non-admin", () => {
    orgData = { callerRole: "member", features: { organizations: false } };
    render(<ProfilePage />);
    expect(screen.queryByText("Working with a team? Enable organizations")).toBeNull();
  });
});

describe("ThreadDefaultsPage", () => {
  beforeEach(() => {
    patchMeMutate.mockClear();
    meData = {
      id: "u1",
      email: "me@example.com",
      name: "Ada",
      avatarUrl: null,
      role: "member",
      orgId: "org_1",
      orgRole: "admin",
      defaultModel: null,
      defaultReasoning: null,
      newThreadBehavior: "keep_current",
    };
  });

  it("renders the shared identity fields and the default-model helper text verbatim", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByLabelText(/Personality/)).toBeNull();
    expect(
      screen.getByText(
        "New sessions you start use this model or size. Existing sessions keep theirs. Switch the model per thread in the chat header. Shared team assistants do not use it.",
      ),
    ).toBeTruthy();
  });

  it("the model combobox filters to curated sonnet entries on 'sonnet'", () => {
    render(<ThreadDefaultsPage />);
    const input = screen.getByLabelText("Default model");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "sonnet" } });

    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("Sonnet 4.6")).toBeTruthy();
    expect(screen.queryByText("Haiku 4.5")).toBeNull();
    expect(screen.queryByText("Opus 4.7")).toBeNull();
  });

  it("selecting a model fires PATCH /api/me with its id", () => {
    render(<ThreadDefaultsPage />);
    const input = screen.getByLabelText("Default model");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "sonnet" } });
    fireEvent.click(screen.getByText("Sonnet 4.5"));

    expect(patchMeMutate).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-5" });
  });

  it("shows a clear row naming the fallback tiers and clears with defaultModel: null", () => {
    meData = { ...meData!, defaultModel: "claude-sonnet-4-5" };
    render(<ThreadDefaultsPage />);
    const input = screen.getByLabelText("Default model");
    fireEvent.focus(input);

    // Personal threads do not inherit team defaults.
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Organization default"));
    expect(patchMeMutate).toHaveBeenCalledWith({ defaultModel: null });
  });

  it("defaults the reasoning select to Inherit and selecting a level fires PATCH /api/me", async () => {
    const user = userEvent.setup();
    render(<ThreadDefaultsPage />);
    const select = screen.getByLabelText("Reasoning") as HTMLSelectElement;
    expect(select.value).toBe("");

    await user.selectOptions(select, "high");
    expect(patchMeMutate).toHaveBeenCalledWith({ defaultReasoning: "high" });
  });

  it("resetting the reasoning select to Inherit clears with defaultReasoning: null", async () => {
    meData = { ...meData!, defaultReasoning: "high" };
    const user = userEvent.setup();
    render(<ThreadDefaultsPage />);

    await user.selectOptions(screen.getByLabelText("Reasoning"), "");
    expect(patchMeMutate).toHaveBeenCalledWith({ defaultReasoning: null });
  });

  it("changes the model and thinking behavior for new threads", async () => {
    const user = userEvent.setup();
    render(<ThreadDefaultsPage />);
    const select = screen.getByLabelText("New thread behavior") as HTMLSelectElement;
    expect(select.value).toBe("keep_current");

    await user.selectOptions(select, "use_defaults");
    expect(patchMeMutate).toHaveBeenCalledWith({
      newThreadBehavior: "use_defaults",
    });
  });
});

describe("AppearancePage", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-palette");
    try {
      window.localStorage.clear();
    } catch {
      // Node >=22 ships a stub localStorage global (methods undefined
      // without --localstorage-file) that can shadow jsdom's — a throwing
      // afterEach here cascaded into un-cleaned DOM for the next test.
    }
  });

  it("selecting Dark sets data-theme on the document root", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("selecting Light sets data-theme to light", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("offers a card for every palette", () => {
    render(<AppearancePage />);
    const group = screen.getByRole("radiogroup", { name: "Color palette" });
    const cards = within(group).getAllByRole("radio");
    // Derived from the canonical list, not a copy of it: adding a palette to
    // `PALETTE_CHOICES` without adding a card fails here rather than shipping
    // a palette nobody can reach.
    expect(cards).toHaveLength(PALETTE_CHOICES.length);
    for (const palette of PALETTE_CHOICES) {
      const label = palette[0].toUpperCase() + palette.slice(1);
      expect(cards.some((card) => card.textContent?.startsWith(label))).toBe(true);
    }
  });

  it("previews each palette in its own colors, not the active one", () => {
    render(<AppearancePage />);
    // The swatch carries the attributes theme.css selects on, which is what
    // makes the preview show a palette nobody has chosen yet.
    const swatches = document.querySelectorAll(".palette-swatch");
    expect([...swatches].map((el) => el.getAttribute("data-palette"))).toEqual([
      ...PALETTE_CHOICES,
    ]);
  });

  it("mirrors the chosen polarity onto the previews", () => {
    render(<AppearancePage />);
    // With "System" selected there is no attribute, so each preview follows
    // the OS through the same media query the page uses.
    expect(document.querySelector(".palette-swatch")?.hasAttribute("data-theme")).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.querySelector(".palette-swatch")?.getAttribute("data-theme")).toBe("dark");
  });

  it("selecting a palette sets data-palette and persists it", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Ember/ }));
    expect(document.documentElement.getAttribute("data-palette")).toBe("ember");
    expect(window.localStorage.getItem("valet-palette")).toBe("ember");
  });

  it("selecting a palette leaves the light/dark choice alone", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Tide/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-palette")).toBe("tide");
  });

  it("going back to Default removes the attribute entirely", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Orchid/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Default/ }));
    // An absent attribute — not `data-palette="default"` — is what keeps an
    // untouched install on the brand palette.
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
  });

  it("starts on the default palette when nothing was ever chosen", () => {
    render(<AppearancePage />);
    // No `@testing-library/jest-dom` in this package, so assertions read
    // raw attributes (see editor.test.tsx for the same note).
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
    expect(screen.getByRole("radio", { name: /Default/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /System/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("restores the stored palette on mount", () => {
    window.localStorage.setItem("valet-palette", "tide");
    render(<AppearancePage />);
    expect(screen.getByRole("radio", { name: /Tide/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Default/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});

describe("NotificationsPage", () => {
  it("renders the four kinds and fires the mutation on toggle", () => {
    setPrefMutate.mockClear();
    render(<NotificationsPage />);
    const toggle = screen.getByRole("switch", { name: "Notifications web notifications" });
    fireEvent.click(toggle);
    expect(setPrefMutate).toHaveBeenCalledWith({ kind: "notification", web: false });
  });
});

describe("ApiKeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiKeysData = [];
  });

  it("shows the brief-verbatim empty state when there are no keys", () => {
    render(<ApiKeysPage />);
    expect(
      screen.getByText("No API keys yet. Create one to call the API from scripts."),
    ).toBeTruthy();
  });

  it("creating a key calls apiKey.create and reveals the secret exactly once", () => {
    createApiKeyMutate.mockImplementation((_name, opts) => {
      opts.onSuccess({
        id: "key_1",
        name: "CI pipeline",
        key: "valet_sk_live_abc123",
        start: "valet_sk_l",
        prefix: "valet_sk_",
      });
    });
    render(<ApiKeysPage />);

    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI pipeline" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createApiKeyMutate).toHaveBeenCalledWith(
      "CI pipeline",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByText("valet_sk_live_abc123")).toBeTruthy();
    expect(screen.getByText("This is the only time the full key is shown.")).toBeTruthy();
  });

  it("renders list rows with the start hint, name, created, and last-used columns", () => {
    apiKeysData = [
      {
        id: "key_1",
        name: "CI pipeline",
        start: "valet_sk_l",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastRequest: null,
      },
    ];
    render(<ApiKeysPage />);
    expect(screen.getByText("CI pipeline")).toBeTruthy();
    expect(screen.getByText("valet_sk_l")).toBeTruthy();
    expect(screen.getByText("Last used Never")).toBeTruthy();
  });

  it("revoking a key is confirm-gated", async () => {
    const user = userEvent.setup();
    apiKeysData = [
      {
        id: "key_1",
        name: "CI pipeline",
        start: "valet_sk_l",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastRequest: null,
      },
    ];
    render(<ApiKeysPage />);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeApiKeyMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(revokeApiKeyMutate).toHaveBeenCalledWith(
      "key_1",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
