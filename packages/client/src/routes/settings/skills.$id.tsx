import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  MetadataRow,
  MetadataSection,
  SplitDetailLayout,
} from '@/components/content/split-detail-layout';
import { MarkdownEditor } from '@/components/content/markdown-editor';
import {
  canEditSkill,
  getOwnerDisplayName,
  getOwnerInitials,
} from '@/components/content/resource-detail-utils';
import { useSkill, useCreateSkill, useUpdateSkill, useDeleteSkill } from '@/api/skills';
import type { Skill, SkillVisibility } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { slugify } from '@/lib/format';

export const Route = createFileRoute('/settings/skills/$id')({
  component: SkillEditorPage,
});

const sourceBadgeVariant = {
  builtin: 'default',
  plugin: 'secondary',
  managed: 'success',
} as const;

const visibilityBadgeVariant = {
  shared: 'default',
  private: 'secondary',
} as const;

function SkillEditorPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const user = useAuthStore((s) => s.user);

  const { data: skill, isLoading } = useSkill(isNew ? '' : id);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();

  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugManual, setSlugManual] = React.useState(false);
  const [description, setDescription] = React.useState('');
  const [content, setContent] = React.useState('');
  const [visibility, setVisibility] = React.useState<SkillVisibility>('shared');
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (skill) {
      setName(skill.name);
      setSlug(skill.slug);
      setSlugManual(true);
      setDescription(skill.description || '');
      setContent(skill.content);
      setVisibility(skill.visibility);
    }
  }, [skill]);

  const canEdit = isNew || canEditSkill(skill, user);
  const isSaving = createSkill.isPending || updateSkill.isPending;

  const owner = getSkillOwner(skill, user, isNew);
  const ownerLabel = getOwnerDisplayName(owner);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugManual) {
      setSlug(slugify(value));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;

    if (isNew) {
      await createSkill.mutateAsync({
        name,
        slug,
        description: description || undefined,
        content,
        visibility,
      });
    } else {
      await updateSkill.mutateAsync({
        id,
        name,
        slug,
        description: description || undefined,
        content,
        visibility,
      });
    }
    navigate({ to: '/settings/skills' });
  };

  const handleDelete = async () => {
    await deleteSkill.mutateAsync(id);
    navigate({ to: '/settings/skills' });
  };

  if (!isNew && isLoading) {
    return <SkillDetailSkeleton />;
  }

  return (
    <form onSubmit={handleSave}>
      <SplitDetailLayout
        backTo="/settings/skills"
        backLabel="Back to Skills"
        title={isNew ? 'Create Skill' : skill?.name || 'Edit Skill'}
        subtitle={!isNew && skill ? skill.slug : undefined}
        badges={!isNew && skill && (
          <>
            <Badge variant={sourceBadgeVariant[skill.source]}>{skill.source}</Badge>
            <Badge variant={visibilityBadgeVariant[skill.visibility]}>{skill.visibility}</Badge>
          </>
        )}
        actions={canEdit && (
          <Button type="submit" disabled={!name.trim() || !slug.trim() || !content.trim() || isSaving}>
            {isSaving ? 'Saving...' : isNew ? 'Create Skill' : 'Save Changes'}
          </Button>
        )}
        metadata={
          <div className="space-y-4">
            <MetadataSection title="Overview">
              <MetadataRow label="Name">
                <Input
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="My Custom Skill"
                  required
                  disabled={!canEdit}
                />
              </MetadataRow>
              <MetadataRow label="Slug">
                <Input
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugManual(true);
                  }}
                  placeholder="my-custom-skill"
                  pattern="^[a-z0-9\-]+$"
                  required
                  disabled={!canEdit}
                  className="text-sm"
                />
                <p className="mt-1 text-xs text-neutral-400">Lowercase letters, numbers, and dashes only</p>
              </MetadataRow>
              <MetadataRow label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A brief description of what this skill does"
                  rows={4}
                  disabled={!canEdit}
                  className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500"
                />
              </MetadataRow>
            </MetadataSection>

            <MetadataSection title="Ownership">
              <MetadataRow label="Owner">
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8">
                    {owner.ownerAvatarUrl && <AvatarImage src={owner.ownerAvatarUrl} alt={ownerLabel} />}
                    <AvatarFallback>{getOwnerInitials(ownerLabel)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {isNew ? 'You' : ownerLabel}
                    </p>
                    {owner.ownerEmail && (
                      <p className="truncate text-xs text-neutral-400">{owner.ownerEmail}</p>
                    )}
                  </div>
                </div>
              </MetadataRow>
              <MetadataRow label="Visibility">
                <VisibilityControl
                  value={visibility}
                  onChange={setVisibility}
                  disabled={!canEdit}
                />
                {!canEdit && (
                  <p className="mt-1 text-xs text-neutral-400">
                    Only the owner can change visibility.
                  </p>
                )}
              </MetadataRow>
            </MetadataSection>

            {!isNew && skill && (
              <MetadataSection title="Source">
                <MetadataRow label="Type">
                  <Badge variant={sourceBadgeVariant[skill.source]}>{skill.source}</Badge>
                </MetadataRow>
                <MetadataRow label="Status">
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">{skill.status}</span>
                </MetadataRow>
                <MetadataRow label="Updated">
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">
                    {new Date(skill.updatedAt).toLocaleDateString()}
                  </span>
                </MetadataRow>
              </MetadataSection>
            )}

            {!isNew && canEdit && (
              <MetadataSection title="Danger Zone">
                {confirmDelete ? (
                  <div className="space-y-2">
                    <p className="text-sm text-neutral-500">Are you sure?</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={deleteSkill.isPending}
                      >
                        {deleteSkill.isPending ? 'Deleting...' : 'Confirm Delete'}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setConfirmDelete(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete Skill
                  </Button>
                )}
              </MetadataSection>
            )}
          </div>
        }
      >
        <section>
          <div className="mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Content
            </h2>
          </div>
          <MarkdownEditor
            value={content}
            onChange={setContent}
            placeholder="Write skill content in markdown..."
            required
            readOnly={!canEdit}
            minHeightClassName="min-h-[34rem]"
          />
        </section>
      </SplitDetailLayout>
    </form>
  );
}

function VisibilityControl({
  value,
  onChange,
  disabled,
}: {
  value: SkillVisibility;
  onChange: (value: SkillVisibility) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-2">
      {(['shared', 'private'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          disabled={disabled}
          className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            value === option
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function getSkillOwner(skill: Skill | undefined, user: ReturnType<typeof useAuthStore.getState>['user'], isNew: boolean) {
  if (isNew) {
    return {
      ownerId: user?.id ?? null,
      ownerName: user?.name ?? null,
      ownerEmail: user?.email ?? null,
      ownerAvatarUrl: user?.avatarUrl ?? null,
    };
  }

  return {
    ownerId: skill?.ownerId ?? null,
    ownerName: skill?.ownerName ?? null,
    ownerEmail: skill?.ownerEmail ?? null,
    ownerAvatarUrl: skill?.ownerAvatarUrl ?? null,
  };
}

function SkillDetailSkeleton() {
  const pulse = 'animate-pulse rounded bg-neutral-100 dark:bg-neutral-700';
  return (
    <SplitDetailLayout
      backTo="/settings/skills"
      backLabel="Back to Skills"
      title="Loading…"
      metadata={
        <div className="space-y-6">
          <div className="space-y-3">
            <div className={`h-3 w-20 ${pulse}`} />
            <div className={`h-9 ${pulse}`} />
            <div className={`h-9 ${pulse}`} />
            <div className={`h-24 ${pulse}`} />
          </div>
          <div className="space-y-3">
            <div className={`h-3 w-20 ${pulse}`} />
            <div className="flex items-center gap-3">
              <div className={`h-8 w-8 rounded-full ${pulse}`} />
              <div className={`h-4 w-32 ${pulse}`} />
            </div>
            <div className={`h-9 ${pulse}`} />
          </div>
          <div className="space-y-3">
            <div className={`h-3 w-20 ${pulse}`} />
            <div className={`h-5 w-16 ${pulse}`} />
            <div className={`h-4 w-24 ${pulse}`} />
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className={`h-3 w-16 ${pulse}`} />
        <div className={`h-10 ${pulse}`} />
        <div className={`h-[32rem] ${pulse}`} />
      </div>
    </SplitDetailLayout>
  );
}
