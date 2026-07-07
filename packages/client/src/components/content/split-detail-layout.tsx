import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PageContainer } from '@/components/layout/page-container';
import { cn } from '@/lib/cn';

interface SplitDetailLayoutProps {
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  metadata: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function SplitDetailLayout({
  backTo,
  backLabel,
  title,
  subtitle,
  badges,
  actions,
  metadata,
  children,
  className,
}: SplitDetailLayoutProps) {
  return (
    <PageContainer className={cn('flex min-h-dvh flex-col', className)}>
      <div className="mb-4">
        <Link
          to={backTo}
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          &larr; {backLabel}
        </Link>
      </div>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {title}
            </h1>
            {badges}
          </div>
          {subtitle && (
            <div className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              {subtitle}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800 lg:h-[calc(100dvh-9.5rem)]">
          <div className="h-full overflow-y-auto p-4">
            {metadata}
          </div>
        </aside>
        <main className="min-h-0 rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800 lg:h-[calc(100dvh-9.5rem)]">
          <div className="h-full overflow-y-auto p-4">
            {children}
          </div>
        </main>
      </div>
    </PageContainer>
  );
}

interface MetadataSectionProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function MetadataSection({ title, children, className }: MetadataSectionProps) {
  return (
    <section className={cn('border-b border-neutral-200 pb-4 last:border-0 last:pb-0 dark:border-neutral-700', className)}>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

interface MetadataRowProps {
  label: string;
  children: React.ReactNode;
}

export function MetadataRow({ label, children }: MetadataRowProps) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-400">
        {label}
      </div>
      {children}
    </div>
  );
}
