import { useState, useRef, useCallback, useEffect } from 'react';
import type { Message } from '@/api/types';
import type { ConnectedUser } from '@/hooks/use-chat';
import { formatTime } from '@/lib/format';
import { MarkdownContent } from './markdown';
import { ToolCard, type ToolCallData, type ToolCallStatus } from './tool-cards';
import { useDrawer } from '@/routes/sessions/$sessionId';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { MessageCopyButton } from './message-copy-button';
import { ChannelBadge } from '@valet/sdk/ui';

interface MessageItemProps {
  message: Message;
  onRevert?: (messageId: string) => void;
  connectedUsers?: ConnectedUser[];
}

const WORKFLOW_EXECUTE_PROMPT_PREFIX = '__VALET_WORKFLOW_EXECUTE_V1__';

export function MessageItem({ message, onRevert, connectedUsers }: MessageItemProps) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isSystem = message.role === 'system';
  const { activePanel } = useDrawer();
  const compact = activePanel !== null;
  const systemParts = isSystem && message.parts && typeof message.parts === 'object'
    ? (message.parts as unknown as Record<string, unknown>)
    : null;

  // Extract base64 screenshot parts if present
  const screenshotParts = getScreenshotParts(message.parts);

  // Extract audio parts for inline player
  const audioParts = getAudioParts(message.parts);

  // Extract file attachment parts (PDFs, documents)
  const fileParts = getFileParts(message.parts);

  // Extract structured tool data from parts (for tool messages)
  const toolData = isTool ? getToolCallFromParts(message.parts) : null;
  const workflowDispatchMeta = parseWorkflowDispatchMessage(message.content);

  if (workflowDispatchMeta) {
    return (
      <div className="flex justify-center py-2 animate-fade-in">
        <div className="rounded-full bg-blue-500/[0.08] px-3 py-1.5 dark:bg-blue-500/[0.12]">
          <p className="font-mono text-[10px] text-blue-700 dark:text-blue-300">
            Workflow run dispatched
            {workflowDispatchMeta.executionId ? ` (${workflowDispatchMeta.executionId.slice(0, 8)}...)` : ''}
          </p>
        </div>
      </div>
    );
  }

  // User messages: right-aligned bubble with author avatar
  if (isUser) {
    const authorName = message.authorName || message.authorEmail;
    // Prefer persisted avatar URL from message; fall back to connected user cache
    const connectedUser = message.authorId
      ? connectedUsers?.find((u) => u.id === message.authorId)
      : undefined;
    const avatarUrl = message.authorAvatarUrl || connectedUser?.avatarUrl;
    const initials = (authorName || '?')
      .split(/[\s@]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join('');

    const isScheduled = message.authorName === 'Scheduled Task';

    return (
      <div className="group relative flex justify-end gap-2 py-2.5 animate-fade-in">
        <div className={compact ? 'max-w-[90%]' : 'max-w-[75%]'}>
          {(authorName || message.channelType || isScheduled) && (
            <div className="mb-1 flex items-center justify-end gap-1.5 px-1">
              {isScheduled && <ScheduledBadge />}
              {authorName && !isScheduled && (
                <span className="font-mono text-[10px] font-medium text-neutral-400 dark:text-neutral-500">
                  {message.authorName || message.authorEmail}
                </span>
              )}
              {message.channelType && <ChannelBadge channelType={message.channelType} />}
            </div>
          )}
          {screenshotParts.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {screenshotParts.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt="Uploaded image"
                  loading="lazy"
                  className="max-h-[260px] w-full rounded-lg border border-neutral-200 object-contain shadow-sm dark:border-neutral-700"
                />
              ))}
            </div>
          )}
          {audioParts.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {audioParts.map((audio, i) => (
                <AudioPlayer key={i} src={audio.src} filename={audio.filename} transcript={audio.transcript} />
              ))}
            </div>
          )}
          {fileParts.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {fileParts.map((file, i) => (
                <FileChip key={i} {...file} />
              ))}
            </div>
          )}
          {showMessageContent(message.content || '', audioParts.length > 0) && (
            <div className="user-bubble rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-white shadow-sm dark:bg-neutral-100 dark:text-neutral-900 dark:shadow-none [&_.markdown-body]:text-white/95 [&_.markdown-body]:dark:text-neutral-900">
              <MarkdownContent content={message.content || ''} />
            </div>
          )}
          <div className="mt-1 flex items-center justify-end gap-2 px-1">
            <span className="font-mono text-[9px] tabular-nums text-neutral-300 dark:text-neutral-600">
              {formatTime(message.createdAt)}
            </span>
            {(message.content || '').trim().length > 0 && (
              <MessageCopyButton text={message.content} />
            )}
            {onRevert && (
              <button
                type="button"
                onClick={() => onRevert(message.id)}
                className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-medium text-neutral-300 opacity-0 transition-all hover:bg-neutral-100 hover:text-neutral-600 group-hover:opacity-100 dark:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                undo
              </button>
            )}
          </div>
        </div>
        <Avatar className="mt-1 h-5 w-5 shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={authorName || ''} />}
          <AvatarFallback className="text-[8px]">{initials}</AvatarFallback>
        </Avatar>
      </div>
    );
  }

  // Screenshot messages (stored as system role with screenshot parts)
  if (isSystem && screenshotParts.length > 0) {
    return (
      <div className="flex justify-center py-3 animate-fade-in">
        <div className="space-y-1.5">
          {screenshotParts.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={message.content || 'Screenshot'}
              loading="lazy"
              className="max-h-[500px] max-w-full rounded-lg border border-neutral-200 object-contain shadow-sm dark:border-neutral-700"
            />
          ))}
          <p className="text-center font-mono text-[9px] text-neutral-400 dark:text-neutral-500">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  // Session break marker: full-width divider
  if (isSystem && systemParts?.type === 'session-break') {
    return (
      <div className="flex items-center gap-3 py-4">
        <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-700" />
        <span className="shrink-0 font-mono text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          New session
        </span>
        <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-700" />
      </div>
    );
  }

  // Model-switched notices: subtle inline notification
  if (isSystem && message.content.startsWith('Model switched from ')) {
    return (
      <div className="flex justify-center py-2">
        <div className="flex items-center gap-1.5 rounded-full bg-blue-500/[0.06] px-3 py-1 dark:bg-blue-500/[0.08]">
          <SwitchIcon className="h-2.5 w-2.5 text-blue-500/70 dark:text-blue-400/60" />
          <p className="text-center font-mono text-[10px] text-blue-600 dark:text-blue-400/80">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  // System messages: styled with avatar + label
  if (isSystem) {
    const systemTitle = (systemParts?.systemTitle as string) || 'System';
    const systemAvatarUrl = systemParts?.systemAvatarUrl as string | undefined;
    const systemInitials = systemTitle
      .split(/[\s@]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join('');

    return (
      <div className="group relative flex gap-2 py-2.5 animate-fade-in">
        <Avatar className="mt-1 h-5 w-5 shrink-0">
          {systemAvatarUrl && <AvatarImage src={systemAvatarUrl} alt={systemTitle} />}
          <AvatarFallback className="text-[8px]">{systemInitials || 'SYS'}</AvatarFallback>
        </Avatar>
        <div className={compact ? 'max-w-[90%]' : 'max-w-[75%]'}>
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="font-mono text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
              {systemTitle}
            </span>
            <span className="font-mono text-[9px] tabular-nums text-neutral-300 dark:text-neutral-600">
              {formatTime(message.createdAt)}
            </span>
            {(message.content || '').trim().length > 0 && (
              <MessageCopyButton text={message.content} />
            )}
          </div>
          <div className="rounded-2xl rounded-bl-md bg-amber-500/[0.08] px-3 py-2 text-amber-800 shadow-sm dark:bg-amber-500/[0.12] dark:text-amber-100 dark:shadow-none">
            <MarkdownContent content={message.content || ''} />
          </div>
        </div>
      </div>
    );
  }

  // Tool messages (shouldn't appear standalone often, but handle it)
  if (isTool && toolData) {
    return (
      <div className="py-1">
        <ToolCard tool={toolData} />
      </div>
    );
  }

  // Fallback (assistant messages rendered standalone — rare, usually in AssistantTurn)
  return (
    <div className="group relative flex gap-3 py-3 animate-fade-in">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/8 text-accent mt-0.5">
        <BotIcon className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="font-mono text-[11px] font-semibold tracking-tight text-neutral-800 dark:text-neutral-200">
            {isTool ? 'Tool' : 'Agent'}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-neutral-300 dark:text-neutral-600">
            {formatTime(message.createdAt)}
          </span>
          {(message.content || '').trim().length > 0 && (
            <MessageCopyButton text={message.content} className="text-[10px]" />
          )}
        </div>
        <div className="border-l-[1.5px] border-accent/15 pl-3 dark:border-accent/10">
          <MarkdownContent content={message.content || ''} />
        </div>
        {screenshotParts.length > 0 && (
          <div className="mt-2 space-y-2">
            {screenshotParts.map((src, i) => (
              <img
                key={i}
                src={src}
                alt="Screenshot"
                loading="lazy"
                className="max-h-[400px] max-w-full rounded-md border border-neutral-200 object-contain dark:border-neutral-700"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function parseWorkflowDispatchMessage(content: string | undefined): { executionId?: string } | null {
  const trimmed = (content || '').trim();
  if (!trimmed.startsWith(WORKFLOW_EXECUTE_PROMPT_PREFIX)) return null;

  const raw = trimmed.slice(WORKFLOW_EXECUTE_PROMPT_PREFIX.length).trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as { executionId?: unknown };
    if (typeof parsed?.executionId === 'string') {
      return { executionId: parsed.executionId };
    }
  } catch {
    // Ignore JSON parse errors and still treat this as an internal workflow dispatch message.
  }

  return {};
}

/** Extract structured tool call data from parts. */
function getToolCallFromParts(parts: unknown): ToolCallData | null {
  if (!parts || typeof parts !== 'object') return null;

  const p = parts as Record<string, unknown>;

  // Parts is { toolName, status, args, result } from the DO upsert
  if (typeof p.toolName === 'string') {
    return {
      toolName: p.toolName,
      status: (p.status as ToolCallStatus) || 'completed',
      args: p.args ?? null,
      result: p.result ?? null,
    };
  }

  return null;
}

/** Check whether to show textual message content, hiding auto-generated voice note placeholders. */
function showMessageContent(content: string | undefined, hasAudio: boolean): boolean {
  const trimmed = (content || '').trim();
  if (trimmed.length === 0) return false;
  // Hide auto-generated placeholders like "[Voice note, 5s]" or "[Audio: title, 10s]"
  if (hasAudio && /^\[(?:Voice note|Audio)[^\]]*\]$/.test(trimmed)) return false;
  return true;
}

interface AudioPartData {
  src: string;
  filename?: string;
  transcript?: string;
}

/** Extract audio data URIs from message parts (if they exist). */
function getAudioParts(parts: unknown): AudioPartData[] {
  if (!parts || typeof parts !== 'object') return [];

  const result: AudioPartData[] = [];
  const items = Array.isArray(parts) ? parts : [parts];

  for (const part of items) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;

    if (p.type === 'audio' && typeof p.data === 'string') {
      const mime = typeof p.mimeType === 'string' ? p.mimeType : 'audio/webm';
      result.push({
        src: `data:${mime};base64,${p.data}`,
        filename: typeof p.filename === 'string' ? p.filename : undefined,
        transcript: typeof p.transcript === 'string' ? p.transcript : undefined,
      });
    }
  }

  return result;
}

/** Inline audio player with play/pause, waveform-style progress bar, and duration. */
function AudioPlayer({ src, filename, transcript }: { src: string; filename?: string; transcript?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onLoadedMetadata = () => setDuration(audio.duration);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onEnded = () => { setIsPlaying(false); setCurrentTime(0); };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play();
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  }, [duration]);

  const formatDuration = (seconds: number) => {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <>
    <div className="flex items-center gap-2.5 rounded-2xl rounded-br-md bg-neutral-900 px-3 py-2.5 shadow-sm dark:bg-neutral-100">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        onClick={togglePlay}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent/90"
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          className="group relative h-5 cursor-pointer rounded-full"
          onClick={handleSeek}
        >
          {/* Waveform-style bars */}
          <div className="absolute inset-0 flex items-center gap-[2px] px-0.5">
            {Array.from({ length: 32 }).map((_, i) => {
              // Pseudo-random heights for waveform look (seeded by index)
              const h = 30 + ((i * 7 + 13) % 70);
              const filled = (i / 32) * 100 < progress;
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-full transition-colors ${
                    filled
                      ? 'bg-white dark:bg-neutral-800'
                      : 'bg-white/25 dark:bg-neutral-400/30'
                  }`}
                  style={{ height: `${h}%` }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-between px-0.5">
          <span className="font-mono text-[9px] tabular-nums text-white/50 dark:text-neutral-500">
            {formatDuration(currentTime)}
          </span>
          <span className="font-mono text-[9px] tabular-nums text-white/50 dark:text-neutral-500">
            {formatDuration(duration)}
          </span>
        </div>
      </div>
      {filename && !transcript && (
        <span className="hidden max-w-[80px] truncate font-mono text-[9px] text-white/30 dark:text-neutral-400 sm:block">
          {filename}
        </span>
      )}
    </div>
    {transcript && (
      <div className="mt-1 rounded-2xl rounded-tr-md bg-neutral-900/80 px-4 py-2 dark:bg-neutral-200/80">
        <p className="font-mono text-[10px] font-medium uppercase tracking-wider text-white/40 dark:text-neutral-500">
          Transcript
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-white/90 dark:text-neutral-800">
          {transcript}
        </p>
      </div>
    )}
    </>
  );
}

/** Extract non-image/audio file attachments (PDFs, documents) from message parts. */
interface FilePartData {
  filename: string;
  mimeType: string;
}

function getFileParts(parts: unknown): FilePartData[] {
  if (!parts || typeof parts !== 'object') return [];
  const result: FilePartData[] = [];
  const items = Array.isArray(parts) ? parts : [parts];

  for (const part of items) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (p.type === 'file' && typeof p.mimeType === 'string') {
      result.push({
        filename: typeof p.filename === 'string' ? p.filename : 'file',
        mimeType: p.mimeType,
      });
    }
  }
  return result;
}

function FileChip({ filename, mimeType }: FilePartData) {
  const isPdf = mimeType === 'application/pdf';
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      {isPdf ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}
      <span className="max-w-[200px] truncate">{filename}</span>
    </div>
  );
}

/** Extract base64 image data URIs from message parts (if they exist). */
function getScreenshotParts(parts: unknown): string[] {
  if (!parts || typeof parts !== 'object') return [];

  const result: string[] = [];

  // Normalize to array — DO may store a single object or an array
  const items = Array.isArray(parts) ? parts : [parts];

  for (const part of items) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;

    // Match { type: 'screenshot', data: base64 } (from DO screenshot messages)
    if ((p.type === 'screenshot' || p.type === 'image') && typeof p.data === 'string') {
      const mime = typeof p.mimeType === 'string' ? p.mimeType : 'image/png';
      result.push(`data:${mime};base64,${p.data}`);
    }
  }

  return result;
}

function SwitchIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </svg>
  );
}

function ScheduledBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-medium text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
      <ClockIcon className="h-2.5 w-2.5" />
      scheduled
    </span>
  );
}


function ClockIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function BotIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}
