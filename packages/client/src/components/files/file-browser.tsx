import * as React from 'react';
import { useFileList, useFileSearch, type FileEntry } from '@/api/files';
import { FileTree } from './file-tree';
import { FilePreview } from './file-preview';
import { SearchInput } from '@/components/ui/search-input';
import { useIsMobile } from '@/hooks/use-is-mobile';

interface FileBrowserProps {
  sessionId: string;
  initialFilePath?: string | null;
  onFileConsumed?: () => void;
}

export function FileBrowser({ sessionId, initialFilePath, onFileConsumed }: FileBrowserProps) {
  const isMobile = useIsMobile();
  const [currentPath, setCurrentPath] = React.useState('/');
  const [selectedFile, setSelectedFile] = React.useState<FileEntry | null>(null);
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = React.useState('');

  // Auto-select file when opened from sidebar
  React.useEffect(() => {
    if (initialFilePath) {
      const name = initialFilePath.split('/').pop() || initialFilePath;
      const dir = initialFilePath.substring(0, initialFilePath.lastIndexOf('/')) || '/';
      setSelectedFile({ name, path: initialFilePath, type: 'file' });
      setCurrentPath(dir);
      onFileConsumed?.();
    }
  }, [initialFilePath]);

  const { data: fileList, isLoading: isLoadingFiles } = useFileList(sessionId, currentPath);
  const { data: searchResults, isLoading: isSearching } = useFileSearch(
    sessionId,
    searchQuery
  );

  const handleSelect = (file: FileEntry) => {
    if (file.type === 'file') {
      setSelectedFile(file);
    }
  };

  const handleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    setCurrentPath(path);
  };

  const handleNavigateUp = () => {
    if (currentPath === '/' || currentPath === '') return;
    // Handle both absolute (/foo/bar) and relative (foo/bar) paths
    const lastSlash = currentPath.lastIndexOf('/');
    if (lastSlash <= 0) {
      // At top level (e.g. "backend" or "/backend") — go to root
      setCurrentPath('/');
    } else {
      setCurrentPath(currentPath.slice(0, lastSlash));
    }
  };

  const files = fileList?.files ?? [];
  const showingSearch = !!searchQuery && !!searchResults;
  const showMobilePreview = isMobile && !!selectedFile && !showingSearch;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800">
      {/* Search bar */}
      <div className={`border-b border-neutral-200 dark:border-neutral-700 ${isMobile ? 'p-2.5' : 'p-3'}`}>
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search files..."
        />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {isMobile ? (
          <>
            {showMobilePreview && selectedFile ? (
              <div className="flex min-h-0 flex-1 flex-col bg-neutral-50 dark:bg-neutral-900">
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 bg-surface-0 px-3 dark:border-neutral-700 dark:bg-surface-1">
                  <button
                    type="button"
                    onClick={() => setSelectedFile(null)}
                    className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    <BackIcon className="h-4 w-4" />
                    Files
                  </button>
                  <span className="truncate text-[12px] text-neutral-500 dark:text-neutral-400">
                    {selectedFile.path}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <FilePreview sessionId={sessionId} path={selectedFile.path} showHeader={false} />
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {showingSearch ? (
                  <SearchResults
                    results={searchResults.results}
                    isLoading={isSearching}
                    mobile
                    onSelect={(path) => {
                      const file: FileEntry = { name: path.split('/').pop() || '', path, type: 'file' };
                      setSelectedFile(file);
                      setSearchQuery('');
                    }}
                  />
                ) : (
                  <FileTree
                    files={files}
                    selectedPath={selectedFile?.path ?? null}
                    onSelect={handleSelect}
                    onExpand={handleExpand}
                    onNavigateUp={currentPath !== '/' ? handleNavigateUp : undefined}
                    currentPath={currentPath}
                    expandedPaths={expandedPaths}
                    isLoading={isLoadingFiles}
                    mobile
                  />
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {/* File tree sidebar */}
            <div className="w-64 flex-shrink-0 overflow-auto border-r border-neutral-200 dark:border-neutral-700">
              {!showingSearch && currentPath !== '/' && (
                <div className="border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-700/50">
                  <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500" title={currentPath}>
                    {currentPath}
                  </span>
                </div>
              )}
              {showingSearch ? (
                <SearchResults
                  results={searchResults.results}
                  isLoading={isSearching}
                  onSelect={(path) => {
                    const file: FileEntry = { name: path.split('/').pop() || '', path, type: 'file' };
                    setSelectedFile(file);
                  }}
                />
              ) : (
                <FileTree
                  files={files}
                  selectedPath={selectedFile?.path ?? null}
                  onSelect={handleSelect}
                  onExpand={handleExpand}
                  onNavigateUp={currentPath !== '/' ? handleNavigateUp : undefined}
                  currentPath={currentPath}
                  expandedPaths={expandedPaths}
                  isLoading={isLoadingFiles}
                />
              )}
            </div>

            {/* File preview */}
            <div className="flex-1 overflow-hidden bg-neutral-50 dark:bg-neutral-900">
              {selectedFile ? (
                <FilePreview sessionId={sessionId} path={selectedFile.path} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    Select a file to view its contents
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface SearchResultsProps {
  results: Array<{ path: string; line: number; content: string }>;
  isLoading: boolean;
  onSelect: (path: string) => void;
  mobile?: boolean;
}

function SearchResults({ results, isLoading, onSelect, mobile = false }: SearchResultsProps) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700"
          />
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
        No results found
      </div>
    );
  }

  return (
    <div className="space-y-1 p-1">
      {results.map((result, index) => (
        <button
          key={`${result.path}-${result.line}-${index}`}
          onClick={() => onSelect(result.path)}
          className={`w-full rounded-md text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700 ${mobile ? 'min-h-11 p-2.5 text-[14px]' : 'p-2 text-sm'}`}
        >
          <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
            {result.path}
          </p>
          <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
            Line {result.line}: {result.content.trim()}
          </p>
        </button>
      ))}
    </div>
  );
}

function BackIcon({ className }: { className?: string }) {
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
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}
