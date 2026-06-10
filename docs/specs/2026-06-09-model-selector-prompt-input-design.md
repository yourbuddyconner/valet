# Model Selector & Prompt Input Redesign

**Date:** 2026-06-09
**Status:** Approved

## Summary

Replace all plain `<select>` model pickers throughout the client with a command-palette-style `ModelSelector` component inspired by the [ai-elements library](https://github.com/vercel/ai-elements). Simultaneously redesign the `ChatInput` container visual to match the clean bordered PromptInput aesthetic from that library. The `/model` slash command in the chat input is preserved.

## Motivation

The current model selection UX is a plain HTML `<select>` element in four separate places. It has no search, no keyboard navigation, no provider logos, and looks out of place. The ai-elements `ModelSelector` is a searchable command palette (built on `cmdk` + Radix Dialog) that shows provider logos, groups models by provider, supports fuzzy search and keyboard navigation, and has a polished trigger button showing the selected model.

## Architecture

### New dependencies

- `cmdk` — command palette primitive (the same lib shadcn's `Command` wraps)

### New shared UI components

**`packages/client/src/components/ui/command.tsx`**
Standard shadcn-style `Command` component wrapping `cmdk`. Exports: `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator`.

**`packages/client/src/components/ui/model-selector.tsx`**
Thin composable wrappers ported from ai-elements `model-selector.tsx`. Depends on `command.tsx` and the existing `dialog.tsx`. Exports:
- `ModelSelector` — root wrapper (`Dialog`)
- `ModelSelectorTrigger` — dialog trigger (`DialogTrigger`)
- `ModelSelectorContent` — dialog content wrapping `Command` with zero-padding border styling
- `ModelSelectorInput` — search input (`CommandInput`)
- `ModelSelectorList` — results list (`CommandList`)
- `ModelSelectorEmpty` — empty state (`CommandEmpty`)
- `ModelSelectorGroup` — provider group (`CommandGroup`)
- `ModelSelectorItem` — individual model row (`CommandItem`)
- `ModelSelectorLogo` — provider SVG logo from `https://models.dev/logos/{provider}.svg` with dark mode invert
- `ModelSelectorLogoGroup` — overlapping logo cluster for multi-provider display
- `ModelSelectorName` — truncating model name span

### Updated components

**`packages/client/src/components/chat/chat-input.tsx`** (visual redesign)
- Outer container: rounded border, clean background — matching the PromptInput card aesthetic
- Footer row restructured: left side has action buttons (mic, attach); right side has model trigger + send/stop
- The `<select>` is replaced with a `ModelSelectorTrigger` button (ghost style, shows provider logo + model name)
- The `/model` slash command overlay is kept exactly as-is — it remains a working alternative way to pick a model
- All existing logic (slash commands, `@` mentions, audio recording, approval gating, file attachments) is untouched

**`packages/client/src/components/sessions/create-session-dialog.tsx`**
Replace the `<select>` + `<optgroup>` with a full `ModelSelector` dialog. Trigger shows the selected model name and provider logo, or "Auto" with a placeholder when no model is selected.

**`packages/client/src/routes/settings/index.tsx`** (ModelPreferencesSection)
Replace the custom text input + dropdown used for adding models to the preference list with a `ModelSelector` trigger. The drag-to-reorder list of selected models stays as-is.

**`packages/client/src/routes/settings/admin.tsx`**
Same as above — replace the model-add input with `ModelSelector`.

**`packages/client/src/routes/settings/personas.$id.tsx`** and **`packages/client/src/components/personas/persona-editor.tsx`**
Replace `<select>` with `ModelSelector` (single-select, trigger shows current model or "None").

## Provider Logo Mapping

`ModelSelectorLogo` fetches SVGs from `https://models.dev/logos/{provider}.svg`. The `provider` string comes from our `ProviderModels.provider` field (e.g., `"openai"`, `"anthropic"`, `"google"`). These slugs match models.dev's naming. Unknown providers render a broken image gracefully — no error state needed.

## Data Flow

No changes to the data layer. `useAvailableModels()` continues to return `ProviderModels[]` (`{ provider: string; models: ProviderModelEntry[] }`). Each call site maps this to `ModelSelectorGroup` / `ModelSelectorItem` elements exactly as the existing code maps it to `<optgroup>` / `<option>`.

## What Is Not Changing

- The `/model` slash command UX in `ChatInput`
- The drag-to-reorder model preference list in settings
- The `useAvailableModels` hook and worker route
- `ChatInput` logic: slash commands, `@` file mentions, audio recording, image attachments, approval gating, `externalValue` injection

## Out of Scope

- Vendoring the full `PromptInput` component from ai-elements (too tightly coupled to their `InputGroup` primitives and would require ripping out existing `ChatInput` logic)
- Adding file attachment UI to the PromptInput footer (separate concern)
- Fetching model capability metadata (context window, pricing) for display in the picker
