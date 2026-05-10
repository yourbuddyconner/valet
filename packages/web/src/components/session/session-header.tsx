import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { SessionDetail } from "@valet/api/wire";
import { Badge, Button, Spinner, Tooltip } from "~/components/primitives";
import { useDeleteSession } from "~/api/queries";
import type { AgentStatus, ConnectionStatus } from "~/stores/stream";
import { cn } from "~/lib/cn";

export function SessionHeader({
  session,
  agentStatus,
  conn,
}: {
  session: SessionDetail;
  agentStatus: AgentStatus;
  conn: ConnectionStatus;
}) {
  const navigate = useNavigate();
  const del = useDeleteSession();

  async function destroy() {
    if (!confirm(`Delete session and tear down its sandbox?`)) return;
    try {
      await del.mutateAsync(session.id);
      navigate({ to: "/" });
    } catch (err) {
      console.error("delete failed:", err);
    }
  }

  return (
    <header className="border-b border-[--border] px-4 py-3 flex items-center gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-tight truncate">
          {session.title || "Untitled session"}
        </div>
        <div className="text-xs text-[--muted] font-mono truncate">{session.workspace}</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <ConnectionBadge conn={conn} />
        <AgentStatusBadge status={agentStatus} />
        <Tooltip content="Delete session">
          <Button
            variant="ghost"
            size="sm"
            onClick={destroy}
            disabled={del.isPending}
            aria-label="Delete session"
          >
            {del.isPending ? <Spinner size={14} /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

function ConnectionBadge({ conn }: { conn: ConnectionStatus }) {
  const map: Record<ConnectionStatus, { label: string; variant: "neutral" | "success" | "danger" }> = {
    idle: { label: "idle", variant: "neutral" },
    connecting: { label: "connecting", variant: "neutral" },
    open: { label: "live", variant: "success" },
    closed: { label: "offline", variant: "neutral" },
    error: { label: "error", variant: "danger" },
  };
  const { label, variant } = map[conn];
  return <Badge variant={variant}>{label}</Badge>;
}

function AgentStatusBadge({ status }: { status: AgentStatus }) {
  if (status === "idle") return <Badge variant="neutral">idle</Badge>;
  const variant =
    status === "error" ? "danger" : status === "thinking" || status === "tool_calling" ? "accent" : "neutral";
  return (
    <Badge variant={variant} className={cn("inline-flex items-center gap-1.5")}>
      {status !== "queued" && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}
      {status.replace("_", " ")}
    </Badge>
  );
}
