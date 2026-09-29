/**
 * Request principal (TKAI-396). The auth ladder always sets one when it
 * sets `c.var.user`. A team `vlt_` key authenticates as the team; a cookie
 * session and a personal key authenticate as the user. `user` stays on the
 * context for audit (the creating admin on a team key).
 */
export type AuthVia = "session" | "apiKey" | "stub";

export type RequestPrincipal = { type: "user"; id: string } | { type: "team"; id: string };

/** The principal for a caller known to be a user: the auth ladder's user
 * rungs, and agent-facing paths that hold only a user id (a channel
 * identity link, an assistant tool's actor). */
export function userPrincipal(id: string): RequestPrincipal {
  return { type: "user", id };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function coerceApiKeyMetadata(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") return parseApiKeyMetadata(raw);
  return isPlainObject(raw) ? raw : null;
}

export function teamIdFromApiKeyMetadata(metadata: unknown): string | undefined {
  const parsed = coerceApiKeyMetadata(metadata);
  if (!parsed) return undefined;
  const teamId = parsed.teamId;
  return typeof teamId === "string" && teamId.length > 0 ? teamId : undefined;
}

export function parseApiKeyMetadata(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when a better-auth create/update body tries to write `metadata.teamId`. */
export function clientMetadataHasTeamId(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  return teamIdFromApiKeyMetadata(body.metadata) !== undefined;
}

/** True when `path` is `root` itself or a path below it. A prefix match
 * would also admit `/api/sessionsX`; the boundary is the segment. */
function underSegment(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Surfaces a team `vlt_` key may call. Everything else is personal, org, or
 * membership admin — a CI key must not inherit the creating user's rights.
 * `teamId` is the key's own team: runtime reads and ensures are limited
 * to that workspace, including when the creating administrator leaves.
 */
export function teamApiKeyPathAllowed(path: string, method: string, teamId: string): boolean {
  if (path === "/api/me" && method === "GET") return true;
  if (underSegment(path, "/api/sessions")) return true;
  if (underSegment(path, "/api/threads")) return true;
  if (underSegment(path, "/api/workflows")) return true;
  if (path === `/api/workspaces/${teamId}/runtime` && (method === "POST" || method === "GET")) return true;
  if (path === `/api/workspaces/${teamId}/briefings` && method === "GET") return true;
  if (path === `/api/workspaces/${teamId}/active-work` && method === "GET") return true;
  if (path === `/api/workspaces/${teamId}/outcomes` && method === "GET") return true;
  if (path === `/api/workspaces/${teamId}/runtime/info` && method === "GET") return true;
  return false;
}

export type ResolveCreateOwnerResult =
  | { ok: true; owner: { type: "user" | "team"; id: string } }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Who owns a newly created session or workflow. Cookie (and stub) callers
 * may send `teamId` when they are a live member. A personal `vlt_` key
 * cannot. A team key always creates as that team, even after the creating
 * admin leaves — membership is not re-checked.
 */
export async function resolveCreateOwner(opts: {
  principal: RequestPrincipal;
  authVia: AuthVia;
  bodyTeamId: unknown;
  userId: string;
  isTeamMember: (teamId: string) => Promise<boolean>;
}): Promise<ResolveCreateOwnerResult> {
  const { principal, authVia, bodyTeamId, userId, isTeamMember } = opts;

  if (principal.type === "team") {
    if (typeof bodyTeamId === "string" && bodyTeamId !== principal.id) {
      return {
        ok: false,
        status: 403,
        error: "This team API key can only act as its own team. Omit teamId, or send this team's id.",
      };
    }
    return { ok: true, owner: { type: "team", id: principal.id } };
  }

  if (authVia === "apiKey" && typeof bodyTeamId === "string") {
    return {
      ok: false,
      status: 403,
      error:
        "A personal API key cannot create a team-owned resource. Create a team API key from the team workspace.",
    };
  }

  if (typeof bodyTeamId === "string") {
    if (!(await isTeamMember(bodyTeamId))) {
      return { ok: false, status: 404, error: "team not found" };
    }
    return { ok: true, owner: { type: "team", id: bodyTeamId } };
  }

  return { ok: true, owner: { type: "user", id: userId } };
}
