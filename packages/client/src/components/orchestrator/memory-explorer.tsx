import * as React from 'react';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useDebounced } from '@/hooks/use-debounced';
import {
  useMemoryFile,
  useSearchMemoryFiles,
  useDeleteMemoryFile,
} from '@/api/orchestrator';
import type { MemoryFileListing } from '@/api/types';

// ─── Directory color themes ─────────────────────────────────────────────────

const DIR_COLORS: Record<string, { dot: string; bg: string; text: string }> = {
  preferences: {
    dot: 'bg-amber-500',
    bg: 'bg-amber-500/8 dark:bg-amber-400/8',
    text: 'text-amber-700 dark:text-amber-400',
  },
  preference: {
    dot: 'bg-amber-500',
    bg: 'bg-amber-500/8 dark:bg-amber-400/8',
    text: 'text-amber-700 dark:text-amber-400',
  },
  projects: {
    dot: 'bg-sky-500',
    bg: 'bg-sky-500/8 dark:bg-sky-400/8',
    text: 'text-sky-700 dark:text-sky-400',
  },
  project: {
    dot: 'bg-sky-500',
    bg: 'bg-sky-500/8 dark:bg-sky-400/8',
    text: 'text-sky-700 dark:text-sky-400',
  },
  context: {
    dot: 'bg-emerald-500',
    bg: 'bg-emerald-500/8 dark:bg-emerald-400/8',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  workflows: {
    dot: 'bg-violet-500',
    bg: 'bg-violet-500/8 dark:bg-violet-400/8',
    text: 'text-violet-700 dark:text-violet-400',
  },
  workflow: {
    dot: 'bg-violet-500',
    bg: 'bg-violet-500/8 dark:bg-violet-400/8',
    text: 'text-violet-700 dark:text-violet-400',
  },
  journal: {
    dot: 'bg-rose-500',
    bg: 'bg-rose-500/8 dark:bg-rose-400/8',
    text: 'text-rose-700 dark:text-rose-400',
  },
  notes: {
    dot: 'bg-neutral-400 dark:bg-neutral-500',
    bg: 'bg-neutral-500/6 dark:bg-neutral-400/6',
    text: 'text-neutral-600 dark:text-neutral-400',
  },
};

const DEFAULT_DIR_COLOR = {
  dot: 'bg-neutral-400 dark:bg-neutral-500',
  bg: 'bg-neutral-500/6 dark:bg-neutral-400/6',
  text: 'text-neutral-600 dark:text-neutral-400',
};

function getDirColor(dir: string) {
  return DIR_COLORS[dir.toLowerCase()] ?? DEFAULT_DIR_COLOR;
}

// ─── Tree data structure ────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  files: MemoryFileListing[];
  children: TreeNode[];
  totalFiles: number;
  totalSize: number;
}

function buildTree(files: MemoryFileListing[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', files: [], children: [], totalFiles: 0, totalSize: 0 };

  for (const file of files) {
    const segments = file.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = current.children.find((c) => c.name === seg);
      if (!child) {
        const childPath = segments.slice(0, i + 1).join('/');
        child = { name: seg, path: childPath, files: [], children: [], totalFiles: 0, totalSize: 0 };
        current.children.push(child);
      }
      current = child;
    }

    current.files.push(file);
  }

  function computeTotals(node: TreeNode) {
    let totalFiles = node.files.length;
    let totalSize = node.files.reduce((s, f) => s + f.size, 0);
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) {
      computeTotals(child);
      totalFiles += child.totalFiles;
      totalSize += child.totalSize;
    }
    node.totalFiles = totalFiles;
    node.totalSize = totalSize;
  }

  computeTotals(root);
  root.children.sort((a, b) => a.name.localeCompare(b.name));
  return root.children;
}

function collectDirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    paths.push(node.path);
    paths.push(...collectDirPaths(node.children));
  }
  return paths;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fileName(path: string): string {
  const slashIdx = path.lastIndexOf('/');
  return slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// Indentation: base 16px + 20px per depth level
const INDENT_BASE = 16;
const INDENT_PER_LEVEL = 20;

// ─── Main Component ─────────────────────────────────────────────────────────

export function MemoryExplorer({ files }: { files: MemoryFileListing[] }) {
  const [search, setSearch] = React.useState('');
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string> | null>(null);
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);

  const debouncedSearch = useDebounced(search, 300);
  const searchQuery = useSearchMemoryFiles(debouncedSearch);
  const isSearching = debouncedSearch.length >= 2;

  const tree = React.useMemo(() => buildTree(files), [files]);
  const totalSize = React.useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);
  const pinnedCount = React.useMemo(() => files.filter((f) => f.pinned).length, [files]);

  // Initialize all directories as expanded on first render
  React.useEffect(() => {
    if (expandedDirs === null && tree.length > 0) {
      setExpandedDirs(new Set(collectDirPaths(tree)));
    }
  }, [tree, expandedDirs]);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  if (files.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-surface-1">
      {/* Header */}
      <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Memory
            </span>
            <div className="flex items-center gap-2 text-2xs text-neutral-400 dark:text-neutral-500">
              <span className="font-mono tabular-nums">{files.length} files</span>
              <span className="text-neutral-300 dark:text-neutral-700">/</span>
              <span className="font-mono tabular-nums">{formatSize(totalSize)}</span>
              {pinnedCount > 0 && (
                <>
                  <span className="text-neutral-300 dark:text-neutral-700">/</span>
                  <span className="flex items-center gap-1">
                    <PinIcon className="h-2.5 w-2.5 text-violet-500 dark:text-violet-400" />
                    <span className="font-mono tabular-nums">{pinnedCount}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-2.5">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-300 dark:text-neutral-600" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memory files..."
            className="w-full rounded-md border border-neutral-200 bg-neutral-50 py-1.5 pl-8 pr-3 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-accent focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent/50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:bg-surface-0"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-h-[480px] overflow-y-auto">
        {isSearching ? (
          <SearchResults
            results={searchQuery.data ?? []}
            isLoading={searchQuery.isLoading}
            query={debouncedSearch}
            previewPath={previewPath}
            onTogglePreview={(path) => setPreviewPath(previewPath === path ? null : path)}
          />
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800/80">
            {tree.map((node) => (
              <TopLevelDir
                key={node.path}
                node={node}
                expandedDirs={expandedDirs ?? new Set()}
                onToggleDir={toggleDir}
                previewPath={previewPath}
                onTogglePreview={(path) =>
                  setPreviewPath(previewPath === path ? null : path)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Top-Level Directory (colored header) ───────────────────────────────────

function TopLevelDir({
  node,
  expandedDirs,
  onToggleDir,
  previewPath,
  onTogglePreview,
}: {
  node: TreeNode;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  previewPath: string | null;
  onTogglePreview: (path: string) => void;
}) {
  const colors = getDirColor(node.name);
  const expanded = expandedDirs.has(node.path);

  return (
    <div>
      {/* Colored directory header */}
      <button
        onClick={() => onToggleDir(node.path)}
        className={cn(
          'group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50',
          expanded && colors.bg,
        )}
      >
        <ChevronIcon
          className={cn(
            'h-3 w-3 shrink-0 text-neutral-400 transition-transform duration-200 dark:text-neutral-500',
            expanded && 'rotate-90',
          )}
        />
        <span className={cn('h-2 w-2 shrink-0 rounded-full', colors.dot)} />
        <span className={cn('text-xs font-semibold', colors.text)}>
          {node.name}
        </span>
        <span className="ml-auto flex items-center gap-2 text-2xs tabular-nums text-neutral-400 dark:text-neutral-600">
          <span>{node.totalFiles} {node.totalFiles === 1 ? 'file' : 'files'}</span>
          <span className="text-neutral-300 dark:text-neutral-700">&middot;</span>
          <span>{formatSize(node.totalSize)}</span>
        </span>
      </button>

      {/* Children with collapse animation */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <TreeChildren
            node={node}
            depth={1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            previewPath={previewPath}
            onTogglePreview={onTogglePreview}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Recursive tree children ────────────────────────────────────────────────

function TreeChildren({
  node,
  depth,
  expandedDirs,
  onToggleDir,
  previewPath,
  onTogglePreview,
}: {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  previewPath: string | null;
  onTogglePreview: (path: string) => void;
}) {
  // Interleave: subdirectories first, then files
  const items: Array<{ type: 'dir'; node: TreeNode } | { type: 'file'; file: MemoryFileListing }> = [];

  for (const child of node.children) {
    items.push({ type: 'dir', node: child });
  }
  for (const file of node.files) {
    items.push({ type: 'file', file });
  }

  return (
    <>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        if (item.type === 'dir') {
          return (
            <SubDirectory
              key={item.node.path}
              node={item.node}
              depth={depth}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              previewPath={previewPath}
              onTogglePreview={onTogglePreview}
            />
          );
        }
        return (
          <FileRow
            key={item.file.path}
            file={item.file}
            depth={depth}
            isLast={isLast}
            isPreviewOpen={previewPath === item.file.path}
            onTogglePreview={() => onTogglePreview(item.file.path)}
          />
        );
      })}
    </>
  );
}

// ─── Subdirectory row (nested, with folder icon) ────────────────────────────

function SubDirectory({
  node,
  depth,
  expandedDirs,
  onToggleDir,
  previewPath,
  onTogglePreview,
}: {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  previewPath: string | null;
  onTogglePreview: (path: string) => void;
}) {
  const expanded = expandedDirs.has(node.path);
  const paddingLeft = INDENT_BASE + depth * INDENT_PER_LEVEL;

  return (
    <div>
      <button
        onClick={() => onToggleDir(node.path)}
        style={{ paddingLeft }}
        className={cn(
          'group flex w-full items-center gap-2 py-1.5 pr-4 text-left transition-colors',
          'hover:bg-neutral-50 dark:hover:bg-neutral-800/30',
        )}
      >
        <ChevronIcon
          className={cn(
            'h-2.5 w-2.5 shrink-0 text-neutral-300 transition-transform duration-150 dark:text-neutral-600',
            expanded && 'rotate-90',
          )}
        />
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
        <span className="min-w-0 truncate font-mono text-xs font-medium text-neutral-600 dark:text-neutral-400">
          {node.name}
        </span>
        <span className="ml-auto shrink-0 text-2xs tabular-nums text-neutral-300 dark:text-neutral-600">
          {node.totalFiles}
        </span>
      </button>

      {/* Nested children with collapse */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <TreeChildren
            node={node}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            previewPath={previewPath}
            onTogglePreview={onTogglePreview}
          />
        </div>
      </div>
    </div>
  );
}

// ─── File Row ───────────────────────────────────────────────────────────────

function FileRow({
  file,
  depth,
  isLast,
  isPreviewOpen,
  onTogglePreview,
}: {
  file: MemoryFileListing;
  depth: number;
  isLast: boolean;
  isPreviewOpen: boolean;
  onTogglePreview: () => void;
}) {
  const deleteFile = useDeleteMemoryFile();
  const name = fileName(file.path);
  const paddingLeft = INDENT_BASE + depth * INDENT_PER_LEVEL;

  return (
    <div
      className={cn(
        !isLast && !isPreviewOpen && 'border-b border-neutral-50 dark:border-neutral-800/50',
      )}
    >
      <button
        type="button"
        onClick={onTogglePreview}
        aria-expanded={isPreviewOpen}
        aria-label={`Preview ${name}`}
        style={{ paddingLeft }}
        className={cn(
          'group flex w-full items-center gap-2 py-1.5 pr-4 text-left transition-colors',
          'hover:bg-neutral-50 dark:hover:bg-neutral-800/30',
          isPreviewOpen && 'bg-neutral-50 dark:bg-neutral-800/30',
        )}
      >
        {/* Spacer to align with folder chevron */}
        <span className="inline-block w-2.5 shrink-0" />

        {/* File icon */}
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-neutral-300 dark:text-neutral-600" />

        {/* Filename */}
        <span className="min-w-0 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
          {name}
        </span>

        {/* Pin */}
        {file.pinned && (
          <PinIcon className="h-3 w-3 shrink-0 text-violet-500 dark:text-violet-400" />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Metadata */}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-neutral-300 dark:text-neutral-600">
          {formatSize(file.size)}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-neutral-300 dark:text-neutral-600">
          {formatRelativeTime(file.updatedAt)}
        </span>

        {/* Delete */}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            if (!confirm(`Delete ${name}?`)) return;
            deleteFile.mutate(file.path);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              if (!confirm(`Delete ${name}?`)) return;
              deleteFile.mutate(file.path);
            }
          }}
          className={cn(
            'shrink-0 rounded p-0.5 transition-all',
            deleteFile.isPending
              ? 'text-red-400 opacity-100'
              : 'text-neutral-200 opacity-0 hover:text-red-400 group-hover:opacity-100 dark:text-neutral-700 dark:hover:text-red-400',
          )}
          title={`Delete ${name}`}
          aria-label={`Delete ${name}`}
        >
          <TrashIcon className="h-3 w-3" />
        </span>
      </button>

      {/* Content preview */}
      {isPreviewOpen && <FileContentPreview path={file.path} />}
    </div>
  );
}

// ─── File Content Preview ───────────────────────────────────────────────────

function FileContentPreview({ path }: { path: string }) {
  const { data: file, isLoading, isError } = useMemoryFile(path);

  return (
    <div className="animate-fade-in mx-4 mb-2 mt-0.5 overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-700/60 dark:bg-neutral-900/80">
      {/* Preview header */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-700/60">
        <span className="font-mono text-2xs text-neutral-400 dark:text-neutral-500">
          {path}
        </span>
        {file && (
          <span className="ml-auto font-mono text-2xs text-neutral-300 dark:text-neutral-600">
            v{file.version}
          </span>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="px-3 py-4">
          <div className="space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
          </div>
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-xs text-red-400 dark:text-red-500">
          Failed to load file content
        </div>
      ) : file ? (
        <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {file.content || <span className="italic text-neutral-300 dark:text-neutral-600">(empty)</span>}
        </pre>
      ) : (
        <div className="px-3 py-3 text-xs text-neutral-400 dark:text-neutral-600">
          File not found
        </div>
      )}
    </div>
  );
}

// ─── Search Results ─────────────────────────────────────────────────────────

function SearchResults({
  results,
  isLoading,
  query,
  previewPath,
  onTogglePreview,
}: {
  results: { path: string; snippet: string; relevance: number }[];
  isLoading: boolean;
  query: string;
  previewPath: string | null;
  onTogglePreview: (path: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 px-4 py-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-40 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          </div>
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <SearchIcon className="mx-auto h-5 w-5 text-neutral-200 dark:text-neutral-700" />
        <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-600">
          No results for &ldquo;{query}&rdquo;
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-neutral-50 dark:divide-neutral-800/50">
      {results.map((result) => {
        const dir = result.path.split('/')[0] || '_root';
        const colors = getDirColor(dir);

        return (
          <div key={result.path}>
            <button
              type="button"
              onClick={() => onTogglePreview(result.path)}
              aria-expanded={previewPath === result.path}
              aria-label={`Preview ${result.path}`}
              className={cn(
                'group w-full px-4 py-2.5 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/30',
                previewPath === result.path && 'bg-neutral-50 dark:bg-neutral-800/30',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colors.dot)} />
                <span className="font-mono text-xs text-neutral-700 dark:text-neutral-300">
                  {result.path}
                </span>
              </div>
              {result.snippet && (
                <p className="mt-1 ml-3.5 line-clamp-2 text-2xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                  {result.snippet}
                </p>
              )}
            </button>
            {previewPath === result.path && <FileContentPreview path={result.path} />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Empty State ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-neutral-200 px-6 py-10 dark:border-neutral-800">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
        <FolderIcon className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
      </div>
      <p className="mt-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
        No memory files
      </p>
      <p className="mt-1 max-w-xs text-center text-xs text-neutral-400 dark:text-neutral-600">
        Your orchestrator will create memory files as it learns your preferences, tracks projects, and stores context.
      </p>
    </div>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 1.5h5.5L13 5v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-13a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.25" />
      <path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M1.5 3.5a1 1 0 011-1h3.586a1 1 0 01.707.293L8.5 4.5h5a1 1 0 011 1v7a1 1 0 01-1 1h-12a1 1 0 01-1-1v-9z" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M10.97 2.293a1 1 0 00-1.414 0L7.323 4.526 5.5 4.2a1 1 0 00-.9.27L3.1 5.97a.5.5 0 000 .707l2.474 2.474L3.1 11.625a.707.707 0 001 1l2.474-2.474 2.474 2.474a.5.5 0 00.707 0l1.5-1.5a1 1 0 00.27-.9l-.326-1.823 2.233-2.233a1 1 0 000-1.414L10.97 2.293z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5M5 4.5v8a1 1 0 001 1h4a1 1 0 001-1v-8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
