import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageContainer } from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  usePersona,
  useCreatePersona,
  useUpdatePersona,
  useDeletePersona,
  useUpdatePersonaFiles,
  usePersonaSkills,
  useAttachSkillToPersona,
  useDetachSkillFromPersona,
  usePersonaTools,
  useUpdatePersonaTools,
} from '@/api/personas';
import { useAvailableModels } from '@/api/sessions';
import { SkillPicker } from '@/components/skills/skill-picker';
import { PersonaToolPicker } from '@/components/personas/persona-tool-picker';
import type { PersonaVisibility } from '@/api/types';

export const Route = createFileRoute('/settings/personas/$id')({
  component: PersonaEditorPage,
});

function PersonaEditorPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const { data: persona, isLoading } = usePersona(isNew ? '' : id);
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const updateFiles = useUpdatePersonaFiles();
  const deletePersonaMutation = useDeletePersona();
  const { data: availableModels } = useAvailableModels();

  // Skills
  const { data: personaSkills } = usePersonaSkills(isNew ? '' : id);
  const attachSkill = useAttachSkillToPersona();
  const detachSkill = useDetachSkillFromPersona();

  // Tools
  const { data: personaTools } = usePersonaTools(isNew ? '' : id);
  const updatePersonaTools = useUpdatePersonaTools();

  // Form state
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [icon, setIcon] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState('');
  const [visibility, setVisibility] = React.useState<PersonaVisibility>('shared');
  const [instructions, setInstructions] = React.useState('');
  const [files, setFiles] = React.useState<{ filename: string; content: string; sortOrder: number }[]>([]);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Tools local state for the picker
  const toolEntries = React.useMemo(() => {
    if (!personaTools) return [];
    return personaTools.map((t) => ({
      service: t.service,
      actionId: t.actionId ?? undefined,
      enabled: t.enabled,
    }));
  }, [personaTools]);

  // Populate form when persona loads
  React.useEffect(() => {
    if (persona) {
      setName(persona.name);
      setDescription(persona.description || '');
      setIcon(persona.icon || '');
      setDefaultModel(persona.defaultModel || '');
      setVisibility(persona.visibility);
      const allFiles = persona.files ?? [];
      const primary = allFiles.find((f) => f.filename === 'instructions.md');
      setInstructions(primary?.content || '');
      setFiles(
        allFiles
          .filter((f) => f.filename !== 'instructions.md')
          .map((f) => ({
            filename: f.filename,
            content: f.content,
            sortOrder: f.sortOrder,
          }))
      );
    }
  }, [persona]);

  const isSaving = createPersona.isPending || updatePersona.isPending || updateFiles.isPending;

  const handleNameChange = (v: string) => {
    setName(v);
  };

  const addFile = () => {
    setFiles([...files, { filename: `instructions-${files.length + 1}.md`, content: '', sortOrder: files.length }]);
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const updateFile = (index: number, updates: Partial<{ filename: string; content: string; sortOrder: number }>) => {
    setFiles(files.map((f, i) => (i === index ? { ...f, ...updates } : f)));
  };

  const buildFiles = () => {
    return [
      ...(instructions.trim()
        ? [{ filename: 'instructions.md', content: instructions, sortOrder: 0 }]
        : []),
      ...files,
    ];
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const allFiles = buildFiles();

    if (isNew) {
      const result = await createPersona.mutateAsync({
        name,
        description: description || undefined,
        icon: icon || undefined,
        defaultModel: defaultModel || undefined,
        visibility,
        files: allFiles,
      });
      // Navigate to the new persona so skills/tools sections become available
      if (result?.persona?.id) {
        navigate({ to: '/settings/personas/$id', params: { id: result.persona.id } });
      }
    } else {
      await updatePersona.mutateAsync({
        id,
        name,
        description: description || undefined,
        icon: icon || undefined,
        defaultModel: defaultModel || undefined,
        visibility,
      });
      await updateFiles.mutateAsync({
        personaId: id,
        files: allFiles,
      });
    }
  };

  const handleDelete = async () => {
    await deletePersonaMutation.mutateAsync(id);
    navigate({ to: '/settings/personas' });
  };

  const handleToolsChange = (tools: { service: string; actionId?: string; enabled: boolean }[]) => {
    updatePersonaTools.mutate({ personaId: id, tools });
  };

  // Skills adapter: map personaSkills API response to the shape SkillPicker expects
  const attachedSkills = React.useMemo(() => {
    if (!personaSkills) return [];
    return personaSkills.map((ps) => ({
      id: ps.id,
      name: ps.name,
      slug: ps.slug,
      source: ps.source,
      description: ps.description,
      sortOrder: ps.sortOrder,
    }));
  }, [personaSkills]);

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
          to="/settings/personas"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          &larr; Back to Personas
        </Link>
      </div>

      <form onSubmit={handleSave}>
        {/* Header with title + save button */}
        <div className="mb-6 flex items-start justify-between">
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {isNew ? 'New Persona' : persona?.name || 'Edit Persona'}
          </h1>
          <Button type="submit" disabled={!name.trim() || isSaving}>
            {isSaving ? 'Saving...' : isNew ? 'Create Persona' : 'Save Changes'}
          </Button>
        </div>

        <div className="max-w-2xl space-y-8">
          {/* ── Section 1: General ── */}
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              General
            </h2>
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="w-16">
                  <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Icon
                  </label>
                  <Input
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    placeholder="🤖"
                    className="text-center text-lg"
                    maxLength={4}
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Name
                  </label>
                  <Input
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="Code Reviewer"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Reviews code for quality and best practices"
                  rows={3}
                  className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Default Model
                </label>
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
                <p className="mt-1 text-xs text-neutral-400">
                  Used when a session is created with this persona, unless overridden.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Visibility
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setVisibility('shared')}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      visibility === 'shared'
                        ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                    }`}
                  >
                    Shared
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibility('private')}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
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
            </div>
          </section>

          {/* ── Section 2: System Prompt ── */}
          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              System Prompt
            </h2>
            <p className="mb-4 text-xs text-neutral-400">
              Primary instructions for this persona
            </p>
            <div className="space-y-4">
              <div>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Write persona instructions in markdown...&#10;&#10;Example: You are a code reviewer. Focus on security, performance, and readability."
                  rows={12}
                  className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
                <p className="mt-1 text-xs text-neutral-400">
                  Markdown instructions injected as the primary persona file
                </p>
              </div>

              {/* Additional files */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Additional Files
                  </label>
                  <Button type="button" variant="secondary" onClick={addFile}>
                    Add File
                  </Button>
                </div>

                {files.length === 0 ? (
                  <p className="rounded-md border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
                    No additional files. Use this for supplementary instructions or reference material.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {files.map((file, index) => (
                      <div key={index} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
                        <div className="mb-2 flex items-center gap-2">
                          <Input
                            value={file.filename}
                            onChange={(e) => updateFile(index, { filename: e.target.value })}
                            placeholder="instructions.md"
                            className="flex-1 text-sm"
                          />
                          <Input
                            type="number"
                            value={file.sortOrder}
                            onChange={(e) => updateFile(index, { sortOrder: parseInt(e.target.value) || 0 })}
                            className="w-16 text-sm"
                            min={0}
                            title="Sort order"
                          />
                          <Button type="button" variant="secondary" onClick={() => removeFile(index)}>
                            Remove
                          </Button>
                        </div>
                        <textarea
                          value={file.content}
                          onChange={(e) => updateFile(index, { content: e.target.value })}
                          placeholder="Write persona instructions in markdown..."
                          rows={6}
                          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* ── Section 3: Skills ── */}
          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Skills
            </h2>
            <p className="mb-4 text-xs text-neutral-400">
              Skills loaded into context at session start
            </p>
            {isNew ? (
              <p className="rounded-md border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
                Save the persona first to attach skills.
              </p>
            ) : (
              <SkillPicker
                attachedSkills={attachedSkills}
                onAttach={(skillId) => attachSkill.mutate({ personaId: id, skillId })}
                onDetach={(skillId) => detachSkill.mutate({ personaId: id, skillId })}
              />
            )}
          </section>

          {/* ── Section 4: Tools ── */}
          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Tools
            </h2>
            <p className="mb-4 text-xs text-neutral-400">
              Integration tools this persona can use
            </p>
            {isNew ? (
              <p className="rounded-md border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
                Save the persona first to configure tools.
              </p>
            ) : (
              <PersonaToolPicker tools={toolEntries} onChange={handleToolsChange} />
            )}
          </section>

          {/* ── Delete ── */}
          {!isNew && (
            <div className="border-t border-neutral-200 pt-4 dark:border-neutral-700">
              {confirmDelete ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-neutral-500">Are you sure?</span>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deletePersonaMutation.isPending}
                  >
                    {deletePersonaMutation.isPending ? 'Deleting...' : 'Confirm Delete'}
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
                  Delete Persona
                </Button>
              )}
            </div>
          )}
        </div>
      </form>
    </PageContainer>
  );
}
