# Model Selector & Prompt Input Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every plain `<select>` model picker in the client with a beautiful command-palette `ModelSelector` component inspired by ai-elements, and wire it into the chat input and all settings surfaces.

**Architecture:** Add `cmdk` as a dep, build a `Command` UI primitive and thin `ModelSelector` wrappers over `Dialog + Command`, then swap all five model-picker sites. The existing `ChatInput` logic (slash commands, @ mentions, audio, approval gating) is untouched — only the `<select>` element and its surrounding footer layout change.

**Tech Stack:** cmdk, @radix-ui/react-dialog (already installed), Tailwind CSS, React 19

**Spec:** `docs/specs/2026-06-09-model-selector-prompt-input-design.md`

---

## File Map

| Action | Path |
|--------|------|
| Create | `packages/client/src/components/ui/command.tsx` |
| Create | `packages/client/src/components/ui/model-selector.tsx` |
| Modify | `packages/client/src/components/chat/chat-input.tsx` |
| Modify | `packages/client/src/components/sessions/create-session-dialog.tsx` |
| Modify | `packages/client/src/routes/settings/index.tsx` |
| Modify | `packages/client/src/routes/settings/admin.tsx` |
| Modify | `packages/client/src/routes/settings/personas.$id.tsx` |
| Modify | `packages/client/src/components/personas/persona-editor.tsx` |

---

## Task 1: Install cmdk

**Files:**
- Modify: `packages/client/package.json`

- [ ] **Step 1: Install cmdk**

```bash
cd packages/client && pnpm add cmdk
```

Expected output: `+ cmdk X.Y.Z` with no errors.

- [ ] **Step 2: Verify it resolves**

```bash
cd packages/client && pnpm typecheck 2>&1 | head -5
```

Expected: no errors about missing cmdk types (cmdk ships its own types).

---

## Task 2: Build the Command UI primitive

**Files:**
- Create: `packages/client/src/components/ui/command.tsx`

- [ ] **Step 1: Create the file**

```tsx
import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { cn } from '@/lib/cn';

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100',
      className
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b border-neutral-200 px-3 dark:border-neutral-700">
    <SearchIcon className="mr-2 h-4 w-4 shrink-0 text-neutral-400" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:placeholder:text-neutral-500',
        className
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-[320px] overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-6 text-center text-sm text-neutral-500"
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-neutral-900 dark:text-neutral-100',
      '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
      '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
      '[&_[cmdk-group-heading]]:text-neutral-500 dark:[&_[cmdk-group-heading]]:text-neutral-400',
      className
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      'data-[selected=true]:bg-neutral-100 dark:data-[selected=true]:bg-neutral-800',
      className
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 h-px bg-neutral-200 dark:bg-neutral-700', className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
};
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep "command.tsx"
```

Expected: no errors.

---

## Task 3: Build the ModelSelector component

**Files:**
- Create: `packages/client/src/components/ui/model-selector.tsx`

The existing `DialogContent` in `dialog.tsx` adds `p-6` padding and a close button — both wrong for a command palette. This component uses `@radix-ui/react-dialog` primitives directly so we get a clean slate, reusing only the `DialogOverlay` export from `dialog.tsx` for the backdrop.

- [ ] **Step 1: Create the file**

```tsx
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DialogOverlay } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { cn } from '@/lib/cn';

export type ModelSelectorProps = React.ComponentProps<typeof DialogPrimitive.Root>;
export const ModelSelector = (props: ModelSelectorProps) => (
  <DialogPrimitive.Root {...props} />
);

export type ModelSelectorTriggerProps = React.ComponentProps<typeof DialogPrimitive.Trigger>;
export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DialogPrimitive.Trigger {...props} />
);

export type ModelSelectorContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  title?: React.ReactNode;
};
export const ModelSelectorContent = ({
  className,
  children,
  title = 'Select model',
  ...props
}: ModelSelectorContentProps) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
        'overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg',
        'dark:border-neutral-700 dark:bg-neutral-900',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
        'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        className
      )}
      {...props}
    >
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      <Command>{children}</Command>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
);

export type ModelSelectorInputProps = React.ComponentProps<typeof CommandInput>;
export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps) => (
  <CommandInput className={cn('h-auto py-3.5', className)} {...props} />
);

export type ModelSelectorListProps = React.ComponentProps<typeof CommandList>;
export const ModelSelectorList = (props: ModelSelectorListProps) => (
  <CommandList {...props} />
);

export type ModelSelectorEmptyProps = React.ComponentProps<typeof CommandEmpty>;
export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => (
  <CommandEmpty {...props} />
);

export type ModelSelectorGroupProps = React.ComponentProps<typeof CommandGroup>;
export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => (
  <CommandGroup {...props} />
);

export type ModelSelectorItemProps = React.ComponentProps<typeof CommandItem>;
export const ModelSelectorItem = (props: ModelSelectorItemProps) => (
  <CommandItem {...props} />
);

export type ModelSelectorSeparatorProps = React.ComponentProps<typeof CommandSeparator>;
export const ModelSelectorSeparator = (props: ModelSelectorSeparatorProps) => (
  <CommandSeparator {...props} />
);

export type ModelSelectorLogoProps = Omit<React.ComponentProps<'img'>, 'src' | 'alt'> & {
  provider: string;
};
export const ModelSelectorLogo = ({ provider, className, ...props }: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn('size-3 dark:invert', className)}
    height={12}
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
);

export type ModelSelectorLogoGroupProps = React.ComponentProps<'div'>;
export const ModelSelectorLogoGroup = ({ className, ...props }: ModelSelectorLogoGroupProps) => (
  <div
    className={cn(
      'flex shrink-0 items-center -space-x-1',
      '[&>img]:rounded-full [&>img]:bg-white [&>img]:p-px [&>img]:ring-1',
      'dark:[&>img]:bg-neutral-900',
      className
    )}
    {...props}
  />
);

export type ModelSelectorNameProps = React.ComponentProps<'span'>;
export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps) => (
  <span className={cn('flex-1 truncate text-left', className)} {...props} />
);
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep "model-selector.tsx"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd packages/client && pnpm add cmdk
git add packages/client/package.json packages/client/pnpm-lock.yaml packages/client/src/components/ui/command.tsx packages/client/src/components/ui/model-selector.tsx
git commit -m "feat(ui): add Command and ModelSelector components"
```

---

## Task 4: Wire ModelSelector into ChatInput

**Files:**
- Modify: `packages/client/src/components/chat/chat-input.tsx`

Replace the plain `<select>` in the toolbar row with a `ModelSelectorTrigger` button. Add `modelSelectorOpen` state. Keep everything else — slash commands, audio, attachments — untouched.

- [ ] **Step 1: Add imports at the top of `chat-input.tsx`**

After the existing import block (line 9), add:

```tsx
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
```

- [ ] **Step 2: Add `modelSelectorOpen` state**

Inside `ChatInput` function body, after the existing `useState` declarations (around line 168), add:

```tsx
const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
```

- [ ] **Step 3: Replace the `<select>` element**

Find and replace this block (around lines 1026–1043):

```tsx
            {hasModels && (
              <select
                value={selectedModel}
                onChange={(e) => onModelChange?.(e.target.value)}
                className="max-w-[240px] shrink-0 cursor-pointer truncate appearance-none rounded-md border border-neutral-200/60 bg-transparent px-1.5 py-0.5 font-mono text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-300 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/30 dark:border-neutral-700/60 dark:text-neutral-500 dark:hover:border-neutral-600 dark:hover:text-neutral-400"
              >
                <option value="">Default model</option>
                {availableModels.map((provider) => (
                  <optgroup key={provider.provider} label={provider.provider}>
                    {provider.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
```

With:

```tsx
            {hasModels && (
              <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
                <ModelSelectorTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200/60 bg-transparent px-1.5 py-0.5 font-mono text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-300 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/30 dark:border-neutral-700/60 dark:text-neutral-500 dark:hover:border-neutral-600 dark:hover:text-neutral-400"
                  >
                    {selectedModel ? (
                      (() => {
                        const flat = availableModels
                          .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })))
                          .find((m) => m.id === selectedModel);
                        return flat ? (
                          <>
                            <ModelSelectorLogo provider={flat.provider} />
                            <span className="max-w-[140px] truncate">{flat.name}</span>
                          </>
                        ) : (
                          <span className="max-w-[140px] truncate">{selectedModel}</span>
                        );
                      })()
                    ) : (
                      <span>Default model</span>
                    )}
                  </button>
                </ModelSelectorTrigger>
                <ModelSelectorContent>
                  <ModelSelectorInput placeholder="Search models..." />
                  <ModelSelectorList>
                    <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                    {availableModels.map((provider) => (
                      <ModelSelectorGroup key={provider.provider} heading={provider.provider}>
                        {provider.models.map((m) => (
                          <ModelSelectorItem
                            key={m.id}
                            value={m.id}
                            onSelect={() => {
                              onModelChange?.(m.id);
                              setModelSelectorOpen(false);
                            }}
                          >
                            <ModelSelectorLogo provider={provider.provider} />
                            <ModelSelectorName>{m.name}</ModelSelectorName>
                            {selectedModel === m.id && (
                              <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                            )}
                          </ModelSelectorItem>
                        ))}
                      </ModelSelectorGroup>
                    ))}
                  </ModelSelectorList>
                </ModelSelectorContent>
              </ModelSelector>
            )}
```

- [ ] **Step 4: Add `CheckIcon` inline SVG**

At the bottom of `chat-input.tsx`, after the last inline SVG component, add:

```tsx
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep "chat-input"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/chat/chat-input.tsx
git commit -m "feat(chat): replace model <select> with ModelSelector command palette"
```

---

## Task 5: Wire ModelSelector into CreateSessionDialog

**Files:**
- Modify: `packages/client/src/components/sessions/create-session-dialog.tsx`

- [ ] **Step 1: Add imports**

In the import block at the top of the file, after the existing imports, add:

```tsx
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
```

- [ ] **Step 2: Add `modelSelectorOpen` state**

In `CreateSessionDialogContent` (the inner component, around line 200 where the other `useState` calls are), add:

```tsx
const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
```

- [ ] **Step 3: Replace the `<select>` element**

Find and replace the block (around lines 862–886):

```tsx
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value);
                    setModelTouched(true);
                  }}
                  className="w-full cursor-pointer appearance-none rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                >
                  <option value="">
                    {personaDefaultModel
                      ? `Auto (persona default: ${personaDefaultModel})`
                      : 'Auto (session default)'}
                  </option>
                  {availableModels?.map((provider) => (
                    <optgroup key={provider.provider} label={provider.provider}>
                      {provider.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
```

With:

```tsx
                <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
                  <ModelSelectorTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm transition-colors hover:border-neutral-300 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    >
                      {selectedModel ? (
                        (() => {
                          const flat = availableModels
                            ?.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })))
                            .find((m) => m.id === selectedModel);
                          return flat ? (
                            <>
                              <ModelSelectorLogo provider={flat.provider} />
                              <ModelSelectorName>{flat.name}</ModelSelectorName>
                            </>
                          ) : (
                            <ModelSelectorName>{selectedModel}</ModelSelectorName>
                          );
                        })()
                      ) : (
                        <span className="flex-1 text-left text-neutral-500">
                          {personaDefaultModel
                            ? `Auto (persona default: ${personaDefaultModel})`
                            : 'Auto (session default)'}
                        </span>
                      )}
                      <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-neutral-400" />
                    </button>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent>
                    <ModelSelectorInput placeholder="Search models..." />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                      <ModelSelectorItem
                        value="__auto__"
                        onSelect={() => {
                          setSelectedModel('');
                          setModelTouched(true);
                          setModelSelectorOpen(false);
                        }}
                      >
                        <ModelSelectorName className="text-neutral-500">
                          {personaDefaultModel
                            ? `Auto (persona default: ${personaDefaultModel})`
                            : 'Auto (session default)'}
                        </ModelSelectorName>
                        {!selectedModel && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
                      </ModelSelectorItem>
                      <ModelSelectorSeparator />
                      {availableModels?.map((provider) => (
                        <ModelSelectorGroup key={provider.provider} heading={provider.provider}>
                          {provider.models.map((m) => (
                            <ModelSelectorItem
                              key={m.id}
                              value={m.id}
                              onSelect={() => {
                                setSelectedModel(m.id);
                                setModelTouched(true);
                                setModelSelectorOpen(false);
                              }}
                            >
                              <ModelSelectorLogo provider={provider.provider} />
                              <ModelSelectorName>{m.name}</ModelSelectorName>
                              {selectedModel === m.id && (
                                <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                              )}
                            </ModelSelectorItem>
                          ))}
                        </ModelSelectorGroup>
                      ))}
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
```

- [ ] **Step 4: Add `CheckIcon` and `ChevronDownIcon` inline SVGs**

At the bottom of the file, add:

```tsx
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep "create-session-dialog"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/sessions/create-session-dialog.tsx
git commit -m "feat(sessions): replace model <select> with ModelSelector in create dialog"
```

---

## Task 6: Wire ModelSelector into settings/index.tsx (ModelPreferencesSection)

**Files:**
- Modify: `packages/client/src/routes/settings/index.tsx`

Remove the custom text input + dropdown machinery and replace it with a `ModelSelector` trigger button. The drag-to-reorder list of selected models is untouched.

- [ ] **Step 1: Add imports**

Add to the import block at the top of the file:

```tsx
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
```

- [ ] **Step 2: Replace `ModelPreferencesSection` state and add-model UI**

Inside `ModelPreferencesSection`, remove these state declarations and their associated `useEffect` blocks:

```tsx
// REMOVE all of these:
const [newModel, setNewModel] = React.useState('');
const [showDropdown, setShowDropdown] = React.useState(false);
const [highlightedIndex, setHighlightedIndex] = React.useState(0);
const inputRef = React.useRef<HTMLInputElement>(null);
const dropdownRef = React.useRef<HTMLDivElement>(null);
// ... and the 3 useEffect blocks for: outside click, highlight reset, scroll-into-view
// ... and the handleKeyDown function
// ... and the filteredModels useMemo (no longer needed)
```

Add in their place:

```tsx
const [selectorOpen, setSelectorOpen] = React.useState(false);
```

- [ ] **Step 3: Simplify `addModel`**

Replace:

```tsx
  function addModel(modelId?: string) {
    const trimmed = (modelId ?? newModel).trim();
    if (trimmed && !models.includes(trimmed)) {
      setModels([...models, trimmed]);
      setNewModel('');
      setShowDropdown(false);
    }
  }
```

With:

```tsx
  function addModel(modelId: string) {
    if (modelId && !models.includes(modelId)) {
      setModels((prev) => [...prev, modelId]);
    }
  }
```

- [ ] **Step 4: Replace the add-model input block**

Find and replace the entire `<div className="relative max-w-lg">` block (lines 1309–1364 approximately) with:

```tsx
        <ModelSelector open={selectorOpen} onOpenChange={setSelectorOpen}>
          <ModelSelectorTrigger asChild>
            <Button variant="outline" size="sm">
              Add model
            </Button>
          </ModelSelectorTrigger>
          <ModelSelectorContent>
            <ModelSelectorInput placeholder="Search models..." />
            <ModelSelectorList>
              <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
              {availableModels?.map((provider) => (
                <ModelSelectorGroup key={provider.provider} heading={provider.provider}>
                  {provider.models
                    .filter((m) => !models.includes(m.id))
                    .map((m) => (
                      <ModelSelectorItem
                        key={m.id}
                        value={m.id}
                        onSelect={() => {
                          addModel(m.id);
                          setSelectorOpen(false);
                        }}
                      >
                        <ModelSelectorLogo provider={provider.provider} />
                        <ModelSelectorName>{m.name}</ModelSelectorName>
                      </ModelSelectorItem>
                    ))}
                </ModelSelectorGroup>
              ))}
            </ModelSelectorList>
          </ModelSelectorContent>
        </ModelSelector>
```

Also remove the `allModels.length === 0` hint paragraph below it — the empty state is now handled by `ModelSelectorEmpty`.

- [ ] **Step 5: Remove unused imports and variables**

Remove `ProviderModels` type import if it was only used for `flattenModels`. Remove `allModels` useMemo and `FlatModel` interface if no longer referenced. Keep `flattenModels` only if it's still used elsewhere in the file (e.g. for `getModelDisplay`).

- [ ] **Step 6: Typecheck**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep "settings/index"
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/routes/settings/index.tsx
git commit -m "feat(settings): replace model input+dropdown with ModelSelector"
```

---

## Task 7: Wire ModelSelector into settings/admin.tsx (OrgModelPreferencesSection)

**Files:**
- Modify: `packages/client/src/routes/settings/admin.tsx`

Same pattern as Task 6. `OrgModelPreferencesSection` has identical structure.

- [ ] **Step 1: Add imports**

Add to the import block at the top of `admin.tsx`:

```tsx
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
```

- [ ] **Step 2: Replace state in `OrgModelPreferencesSection`**

Remove: `newModel`, `showDropdown`, `highlightedIndex`, `inputRef`, `dropdownRef`, and their three `useEffect` blocks, `handleKeyDown`, `filteredModels` useMemo.

Add:

```tsx
const [selectorOpen, setSelectorOpen] = React.useState(false);
```

- [ ] **Step 3: Simplify `addModel`**

Replace the `addModel` function with:

```tsx
  function addModel(modelId: string) {
    if (modelId && !models.includes(modelId)) {
      setModels((prev) => [...prev, modelId]);
    }
  }
```

- [ ] **Step 4: Replace the add-model input block**

Find the equivalent `<div className="relative max-w-lg">` block in `OrgModelPreferencesSection` and replace it with the same ModelSelector pattern as Task 6 Step 4 (identical JSX, the variable names `availableModels`, `models`, `addModel`, `selectorOpen`, `setSelectorOpen` are the same).

- [ ] **Step 5: Typecheck**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep "settings/admin"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/routes/settings/admin.tsx
git commit -m "feat(admin): replace org model input+dropdown with ModelSelector"
```

---

## Task 8: Wire ModelSelector into persona editor (both files)

**Files:**
- Modify: `packages/client/src/components/personas/persona-editor.tsx`
- Modify: `packages/client/src/routes/settings/personas.$id.tsx`

Both files have a plain `<select>` for `defaultModel`. Replace each with a `ModelSelector` dialog trigger.

- [ ] **Step 1: Add imports to `persona-editor.tsx`**

```tsx
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
```

- [ ] **Step 2: Add `modelSelectorOpen` state to `PersonaEditor`**

Inside the `PersonaEditor` component, after the existing `useState` calls:

```tsx
const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
```

- [ ] **Step 3: Replace the `<select>` in `persona-editor.tsx`**

Find (around line 150):

```tsx
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="w-full cursor-pointer appearance-none rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
              >
                <option value="">Auto (session default)</option>
                {availableModels?.map((provider) => (
                  <optgroup key={provider.provider} label={provider.provider}>
                    {provider.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
```

Replace with:

```tsx
              <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
                <ModelSelectorTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm transition-colors hover:border-neutral-300 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                  >
                    {defaultModel ? (
                      (() => {
                        const flat = availableModels
                          ?.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })))
                          .find((m) => m.id === defaultModel);
                        return flat ? (
                          <>
                            <ModelSelectorLogo provider={flat.provider} />
                            <ModelSelectorName>{flat.name}</ModelSelectorName>
                          </>
                        ) : (
                          <ModelSelectorName>{defaultModel}</ModelSelectorName>
                        );
                      })()
                    ) : (
                      <span className="flex-1 text-left text-neutral-500">Auto (session default)</span>
                    )}
                    <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-neutral-400" />
                  </button>
                </ModelSelectorTrigger>
                <ModelSelectorContent>
                  <ModelSelectorInput placeholder="Search models..." />
                  <ModelSelectorList>
                    <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                    <ModelSelectorItem
                      value="__auto__"
                      onSelect={() => { setDefaultModel(''); setModelSelectorOpen(false); }}
                    >
                      <ModelSelectorName className="text-neutral-500">Auto (session default)</ModelSelectorName>
                      {!defaultModel && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
                    </ModelSelectorItem>
                    <ModelSelectorSeparator />
                    {availableModels?.map((provider) => (
                      <ModelSelectorGroup key={provider.provider} heading={provider.provider}>
                        {provider.models.map((m) => (
                          <ModelSelectorItem
                            key={m.id}
                            value={m.id}
                            onSelect={() => { setDefaultModel(m.id); setModelSelectorOpen(false); }}
                          >
                            <ModelSelectorLogo provider={provider.provider} />
                            <ModelSelectorName>{m.name}</ModelSelectorName>
                            {defaultModel === m.id && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
                          </ModelSelectorItem>
                        ))}
                      </ModelSelectorGroup>
                    ))}
                  </ModelSelectorList>
                </ModelSelectorContent>
              </ModelSelector>
```

- [ ] **Step 4: Add inline SVGs to `persona-editor.tsx`**

At the bottom of the file add:

```tsx
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
```

- [ ] **Step 5: Repeat steps 1–4 for `personas.$id.tsx`**

The `<select>` is inside a `<MetadataRow label="Default Model">` around line 263. It is also gated by `disabled={!canEdit}`. Wrap the `ModelSelectorTrigger > button` with `disabled={!canEdit}` on the button element itself (not the `ModelSelectorTrigger`):

```tsx
                  <button
                    type="button"
                    disabled={!canEdit}
                    className="flex w-full items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm transition-colors hover:border-neutral-300 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                  >
```

Add the same `modelSelectorOpen` state, same ModelSelector JSX pattern, and the same two inline SVG functions at the bottom.

- [ ] **Step 6: Typecheck both files**

```bash
cd packages/client && pnpm typecheck 2>&1 | grep -E "persona"
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/personas/persona-editor.tsx packages/client/src/routes/settings/personas.\$id.tsx
git commit -m "feat(personas): replace model <select> with ModelSelector"
```

---

## Task 9: Build check and PR

- [ ] **Step 1: Full build check**

```bash
cd packages/client && pnpm build 2>&1 | tail -20
```

Expected: `✓ built in Xs` with no TypeScript errors. Fix any `noUnusedLocals` errors (e.g. remove leftover `filteredModels`, `allModels`, `FlatModel`, `newModel` references).

- [ ] **Step 2: Check for leftover `<select>` model pickers**

```bash
grep -rn "<select" packages/client/src --include="*.tsx" | grep -i "model\|optgroup"
```

Expected: no results — all model selects replaced.

- [ ] **Step 3: Create PR**

```bash
git checkout -b feat/model-selector-ui
git push -u origin feat/model-selector-ui
gh pr create \
  --title "feat: command-palette model selector across all surfaces" \
  --body "$(cat <<'EOF'
## Summary

- Adds `cmdk` dependency and builds `Command` + `ModelSelector` UI primitives inspired by the [ai-elements library](https://github.com/vercel/ai-elements)
- Replaces all five plain `<select>` model pickers with a searchable command-palette dialog (provider logos, fuzzy search, keyboard nav, checkmark on selected)
- Surfaces updated: chat input toolbar, create-session dialog, user model preferences, org model preferences, persona editor
- Preserves the `/model` slash command overlay in the chat input

## Test plan

- [ ] Open a session → click the model button in the chat input footer → command palette opens, search works, selecting a model closes the palette and updates the button label
- [ ] `/model ` slash command in chat still shows the inline model overlay
- [ ] Create session dialog → model picker shows provider logo and selected name
- [ ] Settings → Model Preferences → "Add model" button opens palette, selecting a model adds it to the drag list
- [ ] Admin → same as above for org preferences
- [ ] Persona editor → model picker works, disabled when not editable
- [ ] Dark mode: logos invert correctly
EOF
)"
```
