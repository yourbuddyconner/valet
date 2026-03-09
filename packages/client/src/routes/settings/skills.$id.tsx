import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageContainer } from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useSkill, useCreateSkill, useUpdateSkill, useDeleteSkill } from '@/api/skills';
import type { SkillVisibility } from '@/api/types';

export const Route = createFileRoute('/settings/skills/$id')({
  component: SkillEditorPage,
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const sourceBadgeVariant = {
  builtin: 'default',
  plugin: 'secondary',
  managed: 'success',
} as const;

function SkillEditorPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

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

  // Populate form when skill loads
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

  const isReadOnly = !isNew && skill != null && (skill.source === 'builtin' || skill.source === 'plugin');
  const isSaving = createSkill.isPending || updateSkill.isPending;

  const handleNameChange = (v: string) => {
    setName(v);
    if (!slugManual) {
      setSlug(slugify(v));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
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
    return (
      <PageContainer>
        <div className="space-y-4">
          <div className="h-6 w-24 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
          <div className="h-10 w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
          <div className="h-10 w-1/2 animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
          <div className="h-64 w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-700" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-4">
        <Link
          to="/settings/skills"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          &larr; Back to Skills
        </Link>
      </div>

      <form onSubmit={handleSave}>
        <div className="mb-6 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {isNew ? 'Create Skill' : skill?.name || 'Edit Skill'}
            </h1>
            {!isNew && skill && (
              <Badge variant={sourceBadgeVariant[skill.source]}>{skill.source}</Badge>
            )}
          </div>
          {!isReadOnly && (
            <Button type="submit" disabled={!name.trim() || !slug.trim() || !content.trim() || isSaving}>
              {isSaving ? 'Saving...' : isNew ? 'Create Skill' : 'Save Changes'}
            </Button>
          )}
        </div>

        <div className="max-w-2xl space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="My Custom Skill"
              required
              disabled={isReadOnly}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Slug
            </label>
            <Input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugManual(true);
              }}
              placeholder="my-custom-skill"
              pattern="^[a-z0-9\-]+$"
              required
              disabled={isReadOnly}
              className="text-sm"
            />
            <p className="mt-1 text-xs text-neutral-400">Lowercase letters, numbers, and dashes only</p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of what this skill does"
              rows={3}
              disabled={isReadOnly}
              className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Visibility
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => !isReadOnly && setVisibility('shared')}
                disabled={isReadOnly}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  visibility === 'shared'
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
              >
                Shared
              </button>
              <button
                type="button"
                onClick={() => !isReadOnly && setVisibility('private')}
                disabled={isReadOnly}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  visibility === 'private'
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
              >
                Private
              </button>
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              {visibility === 'shared' ? 'Visible to all org members' : 'Only visible to you'}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Content
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write skill content in markdown..."
              rows={18}
              required
              disabled={isReadOnly}
              className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500"
            />
          </div>

          {!isNew && !isReadOnly && (
            <div className="border-t border-neutral-200 pt-4 dark:border-neutral-700">
              {confirmDelete ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-neutral-500">Are you sure?</span>
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
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete Skill
                </Button>
              )}
            </div>
          )}
        </div>
      </form>
    </PageContainer>
  );
}
