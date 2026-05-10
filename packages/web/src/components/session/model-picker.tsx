import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { MODEL_CATALOG, modelLabel, type ModelOption } from "~/lib/models";
import { cn } from "~/lib/cn";

/**
 * Model selector with two render variants:
 *
 *   - "compact" (default): small ghost button showing the current model's
 *     short label + a chevron. Used in tight headers (session header,
 *     thread row inline edit).
 *   - "row": full-width row layout with label + description; the "thread
 *     override" indicator is a tiny dot when `isOverride` is true. Used in
 *     the thread sidebar.
 *
 * Pass `currentId` (string | undefined) — undefined renders as "Inherit
 * from session" when `inheritLabel` is given. Selecting an item fires
 * `onSelect(id)`. The optional `onClear` callback, when given, adds an
 * "Inherit from session" item at the bottom that calls `onClear()`.
 */
export interface ModelPickerProps {
  currentId?: string;
  variant?: "compact" | "row";
  /** Called when the user picks a model. Returns the model id. */
  onSelect: (id: string) => void;
  /** When given, renders an extra item that resets to the inherited default. */
  onClear?: () => void;
  /** Indicator next to compact label when this is an override. */
  isOverride?: boolean;
  /** Disable interactions (e.g. while a mutation is in flight). */
  disabled?: boolean;
  /** Label shown when currentId is undefined and onClear is set. */
  inheritLabel?: string;
}

export function ModelPicker({
  currentId,
  variant = "compact",
  onSelect,
  onClear,
  isOverride,
  disabled,
  inheritLabel = "Inherit",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);

  const triggerLabel = currentId ? modelLabel(currentId) : inheritLabel;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "font-normal gap-1.5",
            variant === "row" && "w-full justify-start",
          )}
          aria-label="Choose model"
        >
          <Sparkles
            className={cn(
              "h-3.5 w-3.5",
              isOverride
                ? "text-violet-600 dark:text-violet-400"
                : "text-[--muted]",
            )}
            aria-hidden
          />
          <span className="truncate text-xs">
            {triggerLabel}
          </span>
          {isOverride && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500"
              aria-label="thread override"
            />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-[--muted] shrink-0 ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[280px]">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <ModelGroup
          tier="fast"
          currentId={currentId}
          onPick={(id) => {
            onSelect(id);
            setOpen(false);
          }}
        />
        <DropdownMenuSeparator />
        <ModelGroup
          tier="balanced"
          currentId={currentId}
          onPick={(id) => {
            onSelect(id);
            setOpen(false);
          }}
        />
        <DropdownMenuSeparator />
        <ModelGroup
          tier="powerful"
          currentId={currentId}
          onPick={(id) => {
            onSelect(id);
            setOpen(false);
          }}
        />
        {onClear && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                onClear();
                setOpen(false);
              }}
              className="text-[--muted]"
            >
              <span className="text-xs italic">{inheritLabel}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TIER_LABEL: Record<ModelOption["tier"], string> = {
  fast: "Fast",
  balanced: "Balanced",
  powerful: "Powerful",
};

function ModelGroup({
  tier,
  currentId,
  onPick,
}: {
  tier: ModelOption["tier"];
  currentId?: string;
  onPick: (id: string) => void;
}) {
  const items = MODEL_CATALOG.filter((m) => m.tier === tier);
  if (items.length === 0) return null;
  return (
    <div className="py-0.5">
      <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wider text-[--muted]/70">
        {TIER_LABEL[tier]}
      </div>
      {items.map((m) => {
        const active = m.id === currentId;
        return (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onPick(m.id)}
            className={cn(
              "flex flex-col items-stretch gap-0.5 py-1.5",
              active && "bg-neutral-100 dark:bg-neutral-800",
            )}
          >
            <div className="flex items-center gap-2">
              {active ? (
                <Check className="h-3.5 w-3.5 text-accent-600 shrink-0" />
              ) : (
                <span className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="text-sm font-medium">{m.label}</span>
              <span className="ml-auto font-mono text-[10px] text-[--muted]/70">
                {m.id}
              </span>
            </div>
            <div className="pl-[22px] text-xs text-[--muted] leading-snug">
              {m.description}
            </div>
          </DropdownMenuItem>
        );
      })}
    </div>
  );
}
