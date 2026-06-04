import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useSearchSkills } from '@/api/skills';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/ui/search-input';


interface AttachedSkill {
  id: string;
  name: string;
  slug: string;
  source: string;
  description?: string | null;
  sortOrder: number;
}

interface SkillPickerProps {
  attachedSkills: AttachedSkill[];
  onAttach: (skillId: string) => void;
  onDetach: (skillId: string) => void;
  readOnly?: boolean;
}

const sourceBadgeVariant: Record<string, 'default' | 'secondary' | 'success'> = {
  builtin: 'default',
  plugin: 'secondary',
  managed: 'success',
};

export function SkillPicker({ attachedSkills, onAttach, onDetach, readOnly = false }: SkillPickerProps) {
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const { data: searchResults, isLoading } = useSearchSkills(debouncedQuery);

  const attachedIds = React.useMemo(
    () => new Set(attachedSkills.map((s) => s.id)),
    [attachedSkills]
  );

  // Close dropdown on outside click or Escape
  React.useEffect(() => {
    if (!dropdownOpen) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dropdownOpen]);

  // Debounce the search query
  React.useEffect(() => {
    if (!query.trim()) {
      setDebouncedQuery('');
      setDropdownOpen(false);
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Open dropdown when debounced query is non-empty
  React.useEffect(() => {
    if (debouncedQuery.length > 0) {
      setDropdownOpen(true);
    }
  }, [debouncedQuery]);

  const handleSearchChange = (value: string) => {
    setQuery(value);
  };

  const handleAttach = (skillId: string) => {
    if (readOnly) return;
    onAttach(skillId);
    setQuery('');
    setDebouncedQuery('');
    setDropdownOpen(false);
  };

  return (
    <div className="space-y-3">
      {/* Search input */}
      {!readOnly && (
        <div ref={containerRef} className="relative">
          <SearchInput
            value={query}
            onChange={handleSearchChange}
            placeholder="Search skills to attach..."
            debounceMs={0} /* debounce handled via useEffect above */
          />

          {/* Dropdown results */}
          {dropdownOpen && debouncedQuery.length > 0 && (
            <div className="absolute z-50 mt-1 w-full rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              <div className="max-h-60 overflow-y-auto">
                {isLoading && (
                  <p className="px-3 py-3 text-center text-sm text-neutral-400">
                    Searching...
                  </p>
                )}
                {!isLoading && searchResults && searchResults.length === 0 && (
                  <p className="px-3 py-3 text-center text-sm text-neutral-400">
                    No skills found
                  </p>
                )}
                {searchResults?.map((skill) => {
                  const isAttached = attachedIds.has(skill.id);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      disabled={isAttached}
                      onClick={() => handleAttach(skill.id)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                        isAttached
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-neutral-900 dark:text-neutral-100">
                            {skill.name}
                          </span>
                          <Badge variant={sourceBadgeVariant[skill.source] ?? 'default'}>
                            {skill.source}
                          </Badge>
                          {isAttached && (
                            <span className="text-xs text-neutral-400">attached</span>
                          )}
                        </div>
                        {skill.description && (
                          <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                            {skill.description}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {/* Create new skill link */}
              <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
                <a
                  href="/settings/skills/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300"
                >
                  + Create new skill
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Attached skills list */}
      <div>
        {attachedSkills.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No skills attached.
          </p>
        ) : (
          <ul className="space-y-2">
            {attachedSkills.map((skill) => (
              <li
                key={skill.id}
                className={cn(
                  'flex items-center justify-between rounded-md border px-3 py-2',
                  'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900',
                  'hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors'
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Link
                    to="/settings/skills/$id"
                    params={{ id: skill.id }}
                    className="truncate text-sm font-medium text-neutral-900 hover:text-accent dark:text-neutral-100"
                  >
                    {skill.name}
                  </Link>
                  <Badge variant={sourceBadgeVariant[skill.source] ?? 'default'}>
                    {skill.source}
                  </Badge>
                  <span className="text-xs text-neutral-400">#{skill.sortOrder}</span>
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onDetach(skill.id)}
                    className="ml-2 flex-shrink-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                    aria-label={`Remove ${skill.name}`}
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
