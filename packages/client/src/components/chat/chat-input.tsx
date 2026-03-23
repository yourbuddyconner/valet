import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useFileFinder, type FileReadResponse } from '@/api/files';
import { api } from '@/api/client';
import { useWakeSession } from '@/api/sessions';
import type { PromptAttachment, ProviderModels } from '@/hooks/use-chat';
import { useAudioRecorder } from '@/hooks/use-audio-recorder';
import { SLASH_COMMANDS } from '@valet/shared';
import { isImageFile, needsProcessing, needsCompression, processImage, perImageBudget } from '@/lib/image-compression';
import { toastError } from '@/hooks/use-toast';

interface ChatInputProps {
  onSend: (content: string, model?: string, attachments?: PromptAttachment[]) => void;
  /** Called when Enter is pressed on an empty composer while a staged queued message exists. */
  onSteerQueued?: () => void;
  /** Whether there is at least one staged queued message waiting locally. */
  hasQueuedDraft?: boolean;
  disabled?: boolean;
  /** Blocks sending but keeps textarea interactive (e.g. during hibernate transitions) */
  sendDisabled?: boolean;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  availableModels?: ProviderModels[];
  selectedModel?: string;
  onModelChange?: (model: string) => void;
  onAbort?: () => void;
  isAgentActive?: boolean;
  sessionId?: string;
  sessionStatus?: string;
  /** When true, uses a more compact layout (hides hint text, tighter padding) */
  compact?: boolean;
  /** Mobile-only: show + actions button in the composer row */
  showActionsButton?: boolean;
  /** Called when the + actions button is tapped */
  onOpenActions?: () => void;
  /** Notifies parent when textarea focus changes (useful for mobile keyboard layout) */
  onFocusChange?: (focused: boolean) => void;
  /** Called when a slash command is executed (e.g. /diff, /stop) */
  onCommand?: (command: string, args?: string) => void;
}

interface FlatModel {
  id: string;
  name: string;
  provider: string;
}

const MAX_IMAGE_ATTACHMENTS = 8;

/**
 * Given the current input value and cursor position, find an active @ mention query.
 * Returns { query, startIndex } or null if no active @ context.
 */
function getAtContext(value: string, cursorPos: number): { query: string; startIndex: number } | null {
  // Scan backward from cursor to find the nearest `@`
  const textBeforeCursor = value.slice(0, cursorPos);
  const atIndex = textBeforeCursor.lastIndexOf('@');
  if (atIndex === -1) return null;

  // @ must not be preceded by a word character (i.e., it should be at start or after whitespace/punctuation)
  if (atIndex > 0 && /\w/.test(textBeforeCursor[atIndex - 1])) return null;

  const query = textBeforeCursor.slice(atIndex + 1);

  // Don't trigger if there's a space in the query (user has moved on)
  if (query.includes(' ') || query.includes('\n')) return null;

  return { query, startIndex: atIndex };
}

/**
 * Truncate a file path for display, showing the last few segments.
 */
function truncatePath(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  const segments = path.split('/');
  let result = segments[segments.length - 1];
  for (let i = segments.length - 2; i >= 0; i--) {
    const next = segments[i] + '/' + result;
    if (next.length > maxLen - 2) {
      return '\u2026/' + result;
    }
    result = next;
  }
  return result;
}

const SUPPORTED_DROP_TYPES = new Set(['application/pdf']);

function isSupportedFile(file: File): boolean {
  return isImageFile(file) || SUPPORTED_DROP_TYPES.has(file.type)
    || file.name.toLowerCase().endsWith('.pdf');
}

function hasSupportedFileInDataTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return Array.from(dataTransfer.files).some((file) => isSupportedFile(file));
  }
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    return Array.from(dataTransfer.items).some(
      (item) => item.kind === 'file' && (item.type.startsWith('image/') || item.type === '' || SUPPORTED_DROP_TYPES.has(item.type))
    );
  }
  return false;
}

export function ChatInput({
  onSend,
  onSteerQueued,
  hasQueuedDraft = false,
  disabled = false,
  sendDisabled = false,
  placeholder = 'Ask or build anything...',
  inputRef,
  availableModels = [],
  selectedModel = '',
  onModelChange,
  onAbort,
  isAgentActive = false,
  sessionId,
  sessionStatus,
  compact = false,
  showActionsButton = false,
  onOpenActions,
  onFocusChange,
  onCommand,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [modelCommandDismissed, setModelCommandDismissed] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [fileHighlightIndex, setFileHighlightIndex] = useState(0);
  const [atMenuDismissed, setAtMenuDismissed] = useState(false);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandHighlightIndex, setCommandHighlightIndex] = useState(0);
  const [isSendingFiles, setIsSendingFiles] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const originalFilesRef = useRef<File[]>([]);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const textareaRef = inputRef ?? internalRef;
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileOverlayRef = useRef<HTMLDivElement>(null);
  const commandOverlayRef = useRef<HTMLDivElement>(null);

  // Wake session on focus if hibernated
  const wakeMutation = useWakeSession();
  const handleFocus = useCallback(() => {
    onFocusChange?.(true);
    if (sessionId && sessionStatus === 'hibernated' && !wakeMutation.isPending) {
      wakeMutation.mutate(sessionId);
    }
  }, [sessionId, sessionStatus, wakeMutation.isPending, onFocusChange]);

  // Track cursor position on every input change and selection change
  const updateCursorPos = useCallback(() => {
    const pos = textareaRef.current?.selectionStart ?? 0;
    setCursorPos(pos);
  }, [textareaRef]);

  // @ mention detection
  const atContext = useMemo(() => {
    if (atMenuDismissed) return null;
    return getAtContext(value, cursorPos);
  }, [value, cursorPos, atMenuDismissed]);

  const atQuery = atContext?.query ?? '';

  // File finder query
  const { data: fileFinderData, isLoading: fileFinderLoading } = useFileFinder(
    sessionId ?? '',
    atQuery
  );
  const filePaths = fileFinderData?.paths ?? [];

  const showFileOverlay = !!atContext && !!sessionId;

  // Reset file highlight when query changes
  useEffect(() => {
    setFileHighlightIndex(0);
  }, [atQuery]);

  // Reset atMenuDismissed when @ context changes (user types a new @)
  useEffect(() => {
    if (atContext) {
      // Only reset if we have a new context
    } else {
      setAtMenuDismissed(false);
    }
  }, [!atContext]);

  // Flatten all models for easier filtering
  const allModels = useMemo<FlatModel[]>(() => {
    return availableModels.flatMap((p) =>
      p.models.map((m) => ({ id: m.id, name: m.name, provider: p.provider }))
    );
  }, [availableModels]);

  // ─── Slash Command Detection ──────────────────────────────────────────
  // Detect /command pattern: input is exactly "/<partial>" with no spaces (command picker)
  // OR "/model <filter>" (model sub-overlay)
  const commandMatch = value.match(/^\/(\w*)$/);
  const modelCommandMatch = value.match(/^\/model(?:\s+(.*))?$/i);
  const isModelSubOverlay = !!modelCommandMatch && !modelCommandDismissed && value.match(/^\/model\s/i);
  const isCommandPicker = !!commandMatch && !commandDismissed && !isModelSubOverlay;

  // Filter commands by partial input
  const commandFilterText = (commandMatch?.[1] ?? '').toLowerCase();
  const filteredCommands = useMemo(() => {
    if (!isCommandPicker) return [] as typeof SLASH_COMMANDS;
    const uiCommands = SLASH_COMMANDS.filter((cmd) => cmd.availableIn.includes('ui'));
    if (!commandFilterText) return uiCommands;
    return uiCommands.filter((cmd) =>
      cmd.name.toLowerCase().includes(commandFilterText) ||
      cmd.description.toLowerCase().includes(commandFilterText)
    );
  }, [isCommandPicker, commandFilterText]);

  // Group filtered commands by category
  const groupedCommands = useMemo(() => {
    const groups: Record<string, typeof filteredCommands> = {};
    for (const cmd of filteredCommands) {
      (groups[cmd.category] ??= []).push(cmd);
    }
    return Object.entries(groups);
  }, [filteredCommands]);

  // Reset command highlight when filter changes
  useEffect(() => {
    setCommandHighlightIndex(0);
  }, [commandFilterText]);

  // Reset command dismissed state when input no longer matches /
  useEffect(() => {
    if (!commandMatch) {
      setCommandDismissed(false);
    }
  }, [!commandMatch]);

  // Detect /model sub-overlay
  const isModelCommand = !!modelCommandMatch && !modelCommandDismissed && !isCommandPicker;
  const filterText = (modelCommandMatch?.[1] ?? '').toLowerCase().trim();

  // Filter models by search text
  const filteredModels = useMemo(() => {
    if (!isModelCommand) return [];
    if (!filterText) return allModels;
    return allModels.filter(
      (m) =>
        m.name.toLowerCase().includes(filterText) ||
        m.id.toLowerCase().includes(filterText) ||
        m.provider.toLowerCase().includes(filterText)
    );
  }, [isModelCommand, filterText, allModels]);

  // Group filtered models by provider for display
  const groupedFiltered = useMemo(() => {
    const groups: Record<string, FlatModel[]> = {};
    for (const m of filteredModels) {
      (groups[m.provider] ??= []).push(m);
    }
    return Object.entries(groups);
  }, [filteredModels]);

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIndex(0);
  }, [filterText]);

  // Reset dismissed state when input no longer matches /model
  useEffect(() => {
    if (!modelCommandMatch) {
      setModelCommandDismissed(false);
    }
  }, [!!modelCommandMatch]);

  const selectModel = useCallback(
    (model: FlatModel) => {
      onModelChange?.(model.id);
      setValue('');
      setModelCommandDismissed(false);
      textareaRef.current?.focus();
    },
    [onModelChange, textareaRef]
  );

  const selectCommand = useCallback(
    (command: typeof SLASH_COMMANDS[number]) => {
      if (command.name === 'model') {
        // Transition to model sub-overlay
        setValue('/model ');
        setCommandDismissed(true);
        setModelCommandDismissed(false);
        textareaRef.current?.focus();
      } else if (command.name === 'help') {
        // Show help inline as a local command
        onCommand?.('help');
        setValue('');
        setCommandDismissed(false);
        textareaRef.current?.focus();
      } else {
        onCommand?.(command.name);
        setValue('');
        setCommandDismissed(false);
        textareaRef.current?.focus();
      }
    },
    [onCommand, textareaRef]
  );

  const selectFile = useCallback(
    (filePath: string) => {
      if (!atContext) return;
      const before = value.slice(0, atContext.startIndex);
      const after = value.slice(cursorPos);
      const newValue = before + '@' + filePath + ' ' + after;
      setValue(newValue);
      setAtMenuDismissed(false);
      // Set cursor after the inserted file path + space
      const newCursorPos = atContext.startIndex + 1 + filePath.length + 1;
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(newCursorPos, newCursorPos);
          setCursorPos(newCursorPos);
        }
      });
    },
    [atContext, value, cursorPos, textareaRef]
  );

  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('Failed to read file'));
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const appendFileAttachments = useCallback(async (files: File[]) => {
    // Log all incoming files for debugging format issues
    for (const f of files) {
      console.log(`[attachment] input file: name=${f.name} type="${f.type}" size=${f.size} isImage=${isImageFile(f)} isPdf=${f.type === 'application/pdf'}`);
    }
    const supported = files.filter((file) => isSupportedFile(file));
    if (supported.length === 0) return;

    // Separate images (need processing) from other files (just read as-is)
    const imageFiles = supported.filter((f) => isImageFile(f));
    const otherFiles = supported.filter((f) => !isImageFile(f));

    // Merge with existing original files, enforce limit
    const mergedFiles = [...originalFilesRef.current, ...imageFiles].slice(0, MAX_IMAGE_ATTACHMENTS);
    const budget = perImageBudget(mergedFiles.length);

    setIsCompressing(true);
    try {
      // Process images
      const imageResults = await Promise.all(
        mergedFiles.map(async (file) => {
          try {
            if (needsProcessing(file) || needsCompression(file, budget)) {
              const url = await processImage(file, budget);
              const mime = url.startsWith('data:image/jpeg') ? 'image/jpeg' : (file.type || 'image/jpeg');
              return { type: 'file' as const, mime, url, filename: file.name };
            }
            const url = await readFileAsDataUrl(file);
            return { type: 'file' as const, mime: file.type || 'image/jpeg', url, filename: file.name };
          } catch (err) {
            console.error('[attachment] failed to process image:', file.name, err);
            toastError(`Failed to process image: ${file.name}`);
            return null;
          }
        })
      );

      // Read non-image files (PDFs etc.) as-is
      // TODO: Upload large files to R2 and pass a URL reference instead of base64
      const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
      const otherResults = await Promise.all(
        otherFiles.map(async (file) => {
          try {
            if (file.size > MAX_FILE_SIZE) {
              toastError(`${file.name} is too large (${(file.size / 1024 / 1024).toFixed(0)}MB). Maximum file size is 25MB.`);
              return null;
            }
            const url = await readFileAsDataUrl(file);
            return { type: 'file' as const, mime: file.type || 'application/octet-stream', url, filename: file.name };
          } catch (err) {
            console.error('[attachment] failed to read file:', file.name, err);
            toastError(`Failed to read file: ${file.name}`);
            return null;
          }
        })
      );

      const next: PromptAttachment[] = [...imageResults, ...otherResults].filter((r) => r !== null);
      originalFilesRef.current = mergedFiles.slice(0, imageResults.filter(r => r !== null).length);
      setAttachments(next);
    } finally {
      setIsCompressing(false);
    }
  }, [readFileAsDataUrl]);

  const handleImageSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    await appendFileAttachments(files);

    // Allow selecting the same file again later.
    event.target.value = '';
  }, [appendFileAttachments]);

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    if (!hasSupportedFileInDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    if (!hasSupportedFileInDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  }, [isDragOver]);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    if (!hasSupportedFileInDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    if (!hasSupportedFileInDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files || []);
    resetDragState();
    if (files.length === 0 || disabled || sendDisabled) return;
    void appendFileAttachments(files);
  }, [appendFileAttachments, disabled, resetDragState, sendDisabled]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    if (disabled || sendDisabled) return;
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void appendFileAttachments(imageFiles);
  }, [appendFileAttachments, disabled, sendDisabled]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    originalFilesRef.current = originalFilesRef.current.filter((_, i) => i !== index);
  }, []);

  // Audio recording
  const { isRecording, duration: recordingDuration, error: micError, startRecording, stopRecording, cancelRecording } = useAudioRecorder();

  const handleMicClick = useCallback(async () => {
    if (isRecording) {
      const blob = await stopRecording();
      if (blob && blob.size > 0) {
        const url = await readFileAsDataUrl(new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }));
        const attachment: PromptAttachment = {
          type: 'file',
          mime: 'audio/webm',
          url,
          filename: `voice-${Date.now()}.webm`,
        };
        setAttachments((prev) => [...prev, attachment].slice(0, MAX_IMAGE_ATTACHMENTS));
      }
    } else {
      await startRecording();
    }
  }, [isRecording, stopRecording, startRecording, readFileAsDataUrl]);

  const formatRecordingDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasText = !!value.trim();
    if (!hasText && attachments.length === 0) {
      if (!disabled && !sendDisabled && !isSendingFiles && hasQueuedDraft && onSteerQueued) {
        onSteerQueued();
      }
      return;
    }
    if (disabled || sendDisabled || isSendingFiles || isCompressing) return;

    // If in command picker, select the highlighted command
    if (isCommandPicker && filteredCommands.length > 0) {
      selectCommand(filteredCommands[commandHighlightIndex]);
      return;
    }

    // If input is a /model command, treat as model selection if there's an exact or single match
    if (modelCommandMatch) {
      if (filteredModels.length === 1) {
        selectModel(filteredModels[0]);
        return;
      }
      if (filteredModels.length > 1) {
        selectModel(filteredModels[highlightIndex]);
        return;
      }
      // No matches — don't send as a message
      return;
    }

    const messageText = value.trim();

    // Extract all @path tokens from the message
    const atMentionRegex = /@([\w./\-[\]()]+)/g;
    const mentions = new Set<string>();
    let match;
    while ((match = atMentionRegex.exec(messageText)) !== null) {
      mentions.add(match[1]);
    }

    // If we have file mentions and a sessionId, fetch file contents
    if (mentions.size > 0 && sessionId) {
      setIsSendingFiles(true);
      try {
        const fileContents = await Promise.allSettled(
          Array.from(mentions).map(async (path) => {
            const data = await api.get<FileReadResponse>(
              `/files/read?sessionId=${sessionId}&path=${encodeURIComponent(path)}`
            );
            return { path, content: data.content };
          })
        );

        // Build the prompt with file context blocks
        const contextBlocks = fileContents
          .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> =>
            r.status === 'fulfilled'
          )
          .map((r) => `<file path="${r.value.path}">\n${r.value.content}\n</file>`)
          .join('\n\n');

        const finalMessage = contextBlocks
          ? contextBlocks + '\n\n' + messageText
          : messageText;

        onSend(finalMessage, selectedModel || undefined, attachments);
      } catch {
        // If file fetching fails, send the message as-is
        onSend(messageText, selectedModel || undefined, attachments);
      } finally {
        setIsSendingFiles(false);
      }
    } else {
      onSend(messageText, selectedModel || undefined, attachments);
    }

    setValue('');
    setAttachments([]);
    originalFilesRef.current = [];
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Command overlay keyboard handling
    if (isCommandPicker && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandHighlightIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandHighlightIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectCommand(filteredCommands[commandHighlightIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCommandDismissed(true);
        return;
      }
    }

    // File overlay keyboard handling takes priority when showing
    if (showFileOverlay && filePaths.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFileHighlightIndex((i) => (i + 1) % filePaths.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFileHighlightIndex((i) => (i - 1 + filePaths.length) % filePaths.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectFile(filePaths[fileHighlightIndex]);
        return;
      }
    }

    if (showFileOverlay && e.key === 'Escape') {
      e.preventDefault();
      setAtMenuDismissed(true);
      return;
    }

    if (isModelCommand && filteredModels.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((i) => (i + 1) % filteredModels.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((i) => (i - 1 + filteredModels.length) % filteredModels.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectModel(filteredModels[highlightIndex]);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        selectModel(filteredModels[highlightIndex]);
        return;
      }
    }

    if (e.key === 'Escape') {
      if (isModelCommand) {
        e.preventDefault();
        setModelCommandDismissed(true);
        return;
      }
      if (isAgentActive && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Scroll highlighted item into view (command overlay)
  useEffect(() => {
    if (!isCommandPicker || !commandOverlayRef.current) return;
    const highlighted = commandOverlayRef.current.querySelector('[data-highlighted="true"]');
    highlighted?.scrollIntoView({ block: 'nearest' });
  }, [commandHighlightIndex, isCommandPicker]);

  // Scroll highlighted item into view (model overlay)
  useEffect(() => {
    if (!isModelCommand || !overlayRef.current) return;
    const highlighted = overlayRef.current.querySelector('[data-highlighted="true"]');
    highlighted?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex, isModelCommand]);

  // Scroll highlighted item into view (file overlay)
  useEffect(() => {
    if (!showFileOverlay || !fileOverlayRef.current) return;
    const highlighted = fileOverlayRef.current.querySelector('[data-highlighted="true"]');
    highlighted?.scrollIntoView({ block: 'nearest' });
  }, [fileHighlightIndex, showFileOverlay]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  const hasModels = availableModels.length > 0;
  const showModelOverlay = isModelCommand && hasModels;
  const showCommandOverlay = isCommandPicker && filteredCommands.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative border-t border-border bg-surface-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] dark:bg-surface-0 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleImageSelect}
        className="hidden"
      />
      {isDragOver && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/50 bg-accent/8">
          <span className="rounded-full bg-surface-0/90 px-3 py-1 font-mono text-[11px] font-medium text-accent shadow-sm dark:bg-surface-2/90">
            Drop image to attach
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-0.5">
          {attachments.map((attachment, index) => (
            <div
              key={`${attachment.filename || 'file'}-${index}`}
              className="relative h-14 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-surface-1 dark:border-neutral-700 dark:bg-surface-2"
            >
              {attachment.mime.startsWith('audio/') ? (
                <div className="flex h-full w-28 items-center gap-1.5 px-2">
                  <MicIcon className="h-4 w-4 shrink-0 text-accent" />
                  <span className="truncate font-mono text-[10px] text-neutral-500">
                    {attachment.filename || 'voice'}
                  </span>
                </div>
              ) : attachment.mime.startsWith('image/') ? (
                <img
                  src={attachment.url}
                  alt={attachment.filename || `Attachment ${index + 1}`}
                  className="h-full w-14 object-cover"
                />
              ) : (
                <div className="flex h-full w-28 items-center gap-1.5 px-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 ${attachment.mime === 'application/pdf' ? 'text-red-500' : 'text-neutral-400'}`}>
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="truncate font-mono text-[10px] text-neutral-500">
                    {attachment.filename || 'file'}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(index)}
                className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white"
                aria-label="Remove attachment"
              >
                <CloseIcon className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {showCommandOverlay && (
          <div
            ref={commandOverlayRef}
            className="absolute bottom-full left-0 right-10 mb-1.5 max-h-60 overflow-y-auto rounded-lg border border-neutral-200 bg-surface-0 shadow-panel dark:border-neutral-700 dark:bg-surface-1"
          >
            {groupedCommands.map(([category, commands]) => (
              <div key={category}>
                <div className="sticky top-0 bg-surface-1/80 px-3 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-neutral-400 backdrop-blur-sm dark:bg-surface-2/80 dark:text-neutral-500">
                  {category}
                </div>
                {commands.map((cmd) => {
                  const idx = filteredCommands.indexOf(cmd);
                  const isHighlighted = idx === commandHighlightIndex;
                  return (
                    <button
                      key={cmd.name}
                      type="button"
                      data-highlighted={isHighlighted}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
                        isHighlighted
                          ? 'bg-accent/8 text-accent dark:bg-accent/15'
                          : 'text-neutral-600 hover:bg-surface-1 dark:text-neutral-400 dark:hover:bg-surface-2'
                      }`}
                      onMouseEnter={() => setCommandHighlightIndex(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectCommand(cmd);
                      }}
                    >
                      <span className="font-semibold">/{cmd.name}</span>
                      {cmd.args && <span className="text-neutral-400 dark:text-neutral-500">{cmd.args}</span>}
                      <span className="flex-1 text-neutral-400 dark:text-neutral-500">{cmd.description}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {showModelOverlay && (
          <div
            ref={overlayRef}
            className="absolute bottom-full left-0 right-10 mb-1.5 max-h-60 overflow-y-auto rounded-lg border border-neutral-200 bg-surface-0 shadow-panel dark:border-neutral-700 dark:bg-surface-1"
          >
            {filteredModels.length === 0 ? (
              <div className="px-3 py-2.5 font-mono text-[10px] text-neutral-400">
                No matching models
              </div>
            ) : (
              groupedFiltered.map(([provider, models]) => (
                <div key={provider}>
                  <div className="sticky top-0 bg-surface-1/80 px-3 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-neutral-400 backdrop-blur-sm dark:bg-surface-2/80 dark:text-neutral-500">
                    {provider}
                  </div>
                  {models.map((m) => {
                    const idx = filteredModels.indexOf(m);
                    const isHighlighted = idx === highlightIndex;
                    const isSelected = m.id === selectedModel;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        data-highlighted={isHighlighted}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
                          isHighlighted
                            ? 'bg-accent/8 text-accent dark:bg-accent/15'
                            : 'text-neutral-600 hover:bg-surface-1 dark:text-neutral-400 dark:hover:bg-surface-2'
                        }`}
                        onMouseEnter={() => setHighlightIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectModel(m);
                        }}
                      >
                        <span className="flex-1">{m.name}</span>
                        {isSelected && (
                          <span className="text-[9px] font-medium text-accent/70">current</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}
        {showFileOverlay && (
          <div
            ref={fileOverlayRef}
            className="absolute bottom-full left-0 right-10 mb-1.5 max-h-60 overflow-y-auto rounded-lg border border-neutral-200 bg-surface-0 shadow-panel dark:border-neutral-700 dark:bg-surface-1"
          >
            {fileFinderLoading ? (
              <div className="px-3 py-2.5 font-mono text-[10px] text-neutral-400">
                Searching...
              </div>
            ) : filePaths.length === 0 ? (
              <div className="px-3 py-2.5 font-mono text-[10px] text-neutral-400">
                {atQuery ? 'No files found' : 'Type to search files...'}
              </div>
            ) : (
              filePaths.map((filePath, idx) => {
                const isHighlighted = idx === fileHighlightIndex;
                return (
                  <button
                    key={filePath}
                    type="button"
                    data-highlighted={isHighlighted}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
                      isHighlighted
                        ? 'bg-accent/8 text-accent dark:bg-accent/15'
                        : 'text-neutral-600 hover:bg-surface-1 dark:text-neutral-400 dark:hover:bg-surface-2'
                    }`}
                    onMouseEnter={() => setFileHighlightIndex(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectFile(filePath);
                    }}
                  >
                    <FileIcon className="h-3 w-3 shrink-0 text-neutral-400" />
                    <span className="flex-1 truncate">{truncatePath(filePath)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
        {/* + actions button — outside container, like ChatGPT */}
        {showActionsButton && (
          <button
            type="button"
            onClick={onOpenActions}
            className="mb-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-surface-1/60 text-neutral-500 transition-colors hover:bg-surface-2 hover:text-neutral-700 dark:border-neutral-700 dark:bg-surface-2 dark:text-neutral-400 dark:hover:bg-surface-3 dark:hover:text-neutral-300"
            title="Open actions"
            aria-label="Open actions"
          >
            <PlusIcon className="h-4 w-4" />
          </button>
        )}
        {/* Input container — textarea + toolbar + send, all in one box */}
        <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-neutral-200 bg-surface-1/40 transition-colors focus-within:border-accent/30 focus-within:bg-surface-0 focus-within:ring-1 focus-within:ring-accent/20 dark:border-neutral-700 dark:bg-surface-1 dark:focus-within:border-accent/30 dark:focus-within:bg-surface-0">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              updateCursorPos();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={handleFocus}
            onBlur={() => onFocusChange?.(false)}
            onSelect={updateCursorPos}
            onClick={updateCursorPos}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-base leading-5 text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-100 dark:placeholder:text-neutral-500 md:text-[13px] md:leading-normal"
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-surface-2 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-surface-3 dark:hover:text-neutral-300"
              title="Attach images"
              aria-label="Attach images"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
            {isRecording ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={cancelRecording}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-surface-2 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-surface-3 dark:hover:text-neutral-300"
                  title="Cancel recording"
                  aria-label="Cancel recording"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
                <span className="flex items-center gap-1 font-mono text-[10px] text-red-500">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                  {formatRecordingDuration(recordingDuration)}
                </span>
                <button
                  type="button"
                  onClick={handleMicClick}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-500 transition-colors hover:bg-red-500/20"
                  title="Stop recording"
                  aria-label="Stop recording"
                >
                  <MicStopIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleMicClick}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-surface-2 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-surface-3 dark:hover:text-neutral-300"
                title="Record voice note"
                aria-label="Record voice note"
              >
                <MicIcon className="h-4 w-4" />
              </button>
            )}
            {micError && (
              <span className="font-mono text-[10px] text-red-400">{micError}</span>
            )}
            <div className="flex-1" />
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
            {/* Send / Stop — circle button inside the container */}
            {isAgentActive ? (
              <button
                type="button"
                onClick={onAbort}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-600 text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-400 dark:text-neutral-900 dark:hover:bg-neutral-300"
                aria-label="Stop"
              >
                <StopIcon className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={(!value.trim() && attachments.length === 0) || disabled || sendDisabled || isSendingFiles || isCompressing}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-800 disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
                aria-label="Send"
              >
                <SendIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      {!compact && (
        <p className="mt-1 hidden font-mono text-[9px] tracking-wide text-neutral-400/70 dark:text-neutral-500 md:block">
          {sessionStatus === 'restoring'
            ? 'restoring session...'
            : sessionStatus === 'hibernated'
              ? 'hibernated — focus to restore'
                : sessionStatus === 'hibernating'
                  ? 'hibernating...'
                : hasQueuedDraft
                  ? 'queued locally — enter again to steer latest · shift+enter for new line'
                : isAgentActive
                  ? 'esc to stop · shift+enter for new line · @ files · / commands · drag images · mic'
                  : 'enter to send · shift+enter for new line · @ files · / commands · drag images · mic'}
        </p>
      )}
    </form>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m21 15-3.8-3.8a1.5 1.5 0 0 0-2.1 0L7 19" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function MicStopIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
