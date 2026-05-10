import { Bot, User as UserIcon, Wrench, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Message, MessagePart } from "@valet/api/wire";
import { Avatar, AvatarFallback } from "~/components/primitives/avatar";
import { Badge } from "~/components/primitives/badge";
import { cn } from "~/lib/cn";

export function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <article className={cn("group flex gap-3 px-4 py-3", isUser && "bg-neutral-100/50 dark:bg-neutral-900/40")}>
      <Avatar size="sm">
        <AvatarFallback>
          {isUser ? <UserIcon className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="text-xs text-[--muted] flex items-center gap-2">
          <span className="font-medium text-[--fg]/80">
            {isUser ? "You" : message.role === "assistant" ? "Assistant" : message.role}
          </span>
          <span>•</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        <div className="space-y-2">
          {message.parts.length === 0 && message.content && (
            <TextBlock text={message.content} />
          )}
          {message.parts.map((part, i) => (
            <PartView key={i} part={part} />
          ))}
        </div>
      </div>
    </article>
  );
}

function PartView({ part }: { part: MessagePart }) {
  if (part.kind === "text") return <TextBlock text={part.text} />;
  return <ToolCallBlock part={part} />;
}

function TextBlock({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="text-sm whitespace-pre-wrap leading-relaxed text-[--fg]/95">{text}</div>
  );
}

function ToolCallBlock({ part }: { part: Extract<MessagePart, { kind: "tool_call" }> }) {
  const isErr = part.status === "error";
  const isDone = part.status === "completed";
  const isRunning = part.status === "running";
  return (
    <div className={cn(
      "rounded-md border bg-neutral-100/50 dark:bg-neutral-900/60 overflow-hidden text-sm",
      isErr ? "border-danger-500/40" : "border-[--border]",
    )}>
      <header className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <Wrench className="h-3.5 w-3.5 text-[--muted]" />
        <span className="font-mono font-medium">{part.toolName}</span>
        <Badge
          variant={isErr ? "danger" : isDone ? "success" : "neutral"}
          className="ml-auto"
        >
          {isRunning ? "running" : part.status}
        </Badge>
      </header>
      {part.args !== undefined && (
        <pre className="px-3 pb-2 text-[11px] font-mono text-[--muted] overflow-x-auto">
          {prettyArgs(part.args)}
        </pre>
      )}
      {(part.result !== undefined || part.error) && (
        <div className={cn(
          "border-t px-3 py-2 text-[11px] font-mono whitespace-pre-wrap",
          isErr ? "border-danger-500/30 text-danger-600 bg-danger-500/5" : "border-[--border] text-[--fg]/80",
        )}>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-sans font-medium mb-1">
            {isErr ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
            {isErr ? "error" : "result"}
          </div>
          {String(part.error ?? part.result ?? "")}
        </div>
      )}
    </div>
  );
}

function prettyArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
