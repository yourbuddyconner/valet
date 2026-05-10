import { Bot, User as UserIcon } from "lucide-react";
import type { Message, MessagePart } from "@valet/api/wire";
import { Avatar, AvatarFallback } from "~/components/primitives/avatar";
import { Markdown } from "~/components/markdown";
import { pickRenderer, ToolShell } from "./tool-renderers";
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
  return <Markdown>{text}</Markdown>;
}

function ToolCallBlock({ part }: { part: Extract<MessagePart, { kind: "tool_call" }> }) {
  const renderer = pickRenderer(part.toolName);
  const target = renderer.formatTarget(part.args);
  const summary = renderer.formatSummary?.(part.args, part.result, part.status);
  const Body = renderer.Body;

  return (
    <ToolShell
      toolName={part.toolName}
      category={renderer.category}
      Icon={renderer.Icon}
      target={target}
      summary={summary}
      status={part.status}
    >
      <Body
        args={part.args}
        result={part.result}
        status={part.status}
        error={part.error}
      />
    </ToolShell>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
