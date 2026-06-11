import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { User } from '@valet/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  MetadataRow,
  MetadataSection,
  SplitDetailLayout,
} from '@/components/content/split-detail-layout';
import { MarkdownEditor } from '@/components/content/markdown-editor';
import { SkillPicker } from '@/components/skills/skill-picker';
import { PersonaToolPicker } from '@/components/personas/persona-tool-picker';
import {
  canEditPersona,
  getOwnerDisplayName,
  getOwnerInitials,
} from '@/components/content/resource-detail-utils';
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
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector';
import { buildModelSelectorGroups } from '@/components/ui/model-selector-utils';
import type { AgentPersona, PersonaVisibility } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

export const Route = createFileRoute('/settings/personas/$id')({
  component: PersonaEditorPage,
});

type PersonaFileDraft = { filename: string; content: string; sortOrder: number };
type PersonaDetailTab = 'files' | 'skills' | 'tools';

const visibilityBadgeVariant = {
  shared: 'default',
  private: 'secondary',
} as const;

function PersonaEditorPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const user = useAuthStore((s) => s.user);
  const orgModelPreferences = useAuthStore((s) => s.orgModelPreferences);

  const { data: persona, isLoading } = usePersona(isNew ? '' : id);
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const updateFiles = useUpdatePersonaFiles();
  const deletePersonaMutation = useDeletePersona();
  const { data: availableModels } = useAvailableModels();
  const modelGroups = React.useMemo(
    () =>
      buildModelSelectorGroups({
        availableModels,
        userModelPreferences: user?.modelPreferences,
        orgModelPreferences,
      }),
    [availableModels, orgModelPreferences, user?.modelPreferences]
  );

  const { data: personaSkills } = usePersonaSkills(isNew ? '' : id);
  const attachSkill = useAttachSkillToPersona();
  const detachSkill = useDetachSkillFromPersona();

  const { data: personaTools } = usePersonaTools(isNew ? '' : id);
  const updatePersonaTools = useUpdatePersonaTools();

  const [activeTab, setActiveTab] = React.useState<PersonaDetailTab>('files');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [icon, setIcon] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState('');
  const [visibility, setVisibility] = React.useState<PersonaVisibility>('shared');
  const [instructions, setInstructions] = React.useState('');
  const [files, setFiles] = React.useState<PersonaFileDraft[]>([]);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);

  const canEdit = isNew || canEditPersona(persona, user);
  const isSaving = createPersona.isPending || updatePersona.isPending || updateFiles.isPending;

  const toolEntries = React.useMemo(() => {
    if (!personaTools) return [];
    return personaTools.map((tool) => ({
      service: tool.service,
      actionId: tool.actionId ?? undefined,
      enabled: tool.enabled,
    }));
  }, [personaTools]);

  const attachedSkills = React.useMemo(() => {
    if (!personaSkills) return [];
    return personaSkills.map((personaSkill) => ({
      id: personaSkill.id,
      name: personaSkill.name,
      slug: personaSkill.slug,
      source: personaSkill.source,
      description: personaSkill.description,
      sortOrder: personaSkill.sortOrder,
    }));
  }, [personaSkills]);

  React.useEffect(() => {
    if (persona) {
      setName(persona.name);
      setDescription(persona.description || '');
      setIcon(persona.icon || '');
      setDefaultModel(persona.defaultModel || '');
      setVisibility(persona.visibility);
      const allFiles = persona.files ?? [];
      const primary = allFiles.find((file) => file.filename === 'instructions.md');
      setInstructions(primary?.content || '');
      setFiles(
        allFiles
          .filter((file) => file.filename !== 'instructions.md')
          .map((file) => ({
            filename: file.filename,
            content: file.content,
            sortOrder: file.sortOrder,
          })),
      );
    }
  }, [persona]);

  const addFile = () => {
    if (!canEdit) return;
    setFiles((current) => [
      ...current,
      { filename: `notes-${current.length + 1}.md`, content: '', sortOrder: current.length + 1 },
    ]);
  };

  const removeFile = (index: number) => {
    if (!canEdit) return;
    setFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const updateFile = (index: number, updates: Partial<PersonaFileDraft>) => {
    if (!canEdit) return;
    setFiles((current) => current.map((file, currentIndex) => (
      currentIndex === index ? { ...file, ...updates } : file
    )));
  };

  const buildFiles = () => [
    ...(instructions.trim()
      ? [{ filename: 'instructions.md', content: instructions, sortOrder: 0 }]
      : []),
    ...files
      .map((file) => ({
        filename: file.filename.trim(),
        content: file.content,
        sortOrder: file.sortOrder,
      }))
      .filter((file) => file.filename.length > 0 && file.content.trim().length > 0),
  ];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;

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
    if (!canEdit) return;
    updatePersonaTools.mutate({ personaId: id, tools });
  };

  if (!isNew && isLoading) {
    return <PersonaDetailSkeleton />;
  }

  const owner = getPersonaOwnerInfo(persona, user, isNew);
  const ownerLabel = getOwnerDisplayName(owner);

  return (
    <form onSubmit={handleSave}>
      <SplitDetailLayout
        backTo="/settings/personas"
        backLabel="Back to Personas"
        title={isNew ? 'New Persona' : persona?.name || 'Edit Persona'}
        subtitle={description || undefined}
        badges={!isNew && persona && (
          <>
            {persona.isDefault && <Badge>default</Badge>}
            <Badge variant={visibilityBadgeVariant[persona.visibility]}>{persona.visibility}</Badge>
          </>
        )}
        actions={canEdit && (
          <Button type="submit" disabled={!name.trim() || isSaving}>
            {isSaving ? 'Saving...' : isNew ? 'Create Persona' : 'Save Changes'}
          </Button>
        )}
        metadata={
          <div className="space-y-4">
            <MetadataSection title="Overview">
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
                <MetadataRow label="Icon">
                  <Input
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    placeholder="AI"
                    className="text-center text-lg"
                    maxLength={4}
                    disabled={!canEdit}
                  />
                </MetadataRow>
                <MetadataRow label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Code Reviewer"
                    required
                    disabled={!canEdit}
                  />
                </MetadataRow>
              </div>
              <MetadataRow label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Reviews code for quality and best practices"
                  rows={4}
                  disabled={!canEdit}
                  className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500"
                />
              </MetadataRow>
              <MetadataRow label="Default Model">
                <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
                  <ModelSelectorTrigger asChild>
                    <button
                      type="button"
                      disabled={!canEdit}
                      className="flex w-full items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm transition-colors hover:border-neutral-300 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                    >
                      {defaultModel ? (
                        (() => {
                          const flat = availableModels
                            ?.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })))
                            ?.find((m) => m.id === defaultModel);
                          return flat ? (
                            <>
                              <ModelSelectorLogo provider={flat.provider} />
                              <ModelSelectorName>{flat.name}</ModelSelectorName>
                            </>
                          ) : (
                            <ModelSelectorName>{defaultModel}</ModelSelectorName>
                          );
                        })()
                      ) : (
                        <span className="flex-1 text-left text-neutral-500">Auto (session default)</span>
                      )}
                      <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 text-neutral-400" />
                    </button>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent>
                    <ModelSelectorInput placeholder="Search models..." />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                      <ModelSelectorItem
                        value="__auto__"
                        onSelect={() => { setDefaultModel(''); setModelSelectorOpen(false); }}
                      >
                        <ModelSelectorName className="text-neutral-500">Auto (session default)</ModelSelectorName>
                        {!defaultModel && <CheckIcon className="ml-auto h-4 w-4 shrink-0" />}
                      </ModelSelectorItem>
                      <ModelSelectorSeparator />
                      {modelGroups.preferredGroup && (
                        <>
                          <ModelSelectorGroup heading={modelGroups.preferredGroup.heading}>
                            {modelGroups.preferredGroup.models.map((m) => (
                              <ModelSelectorItem
                                key={m.id}
                                value={m.id}
                                onSelect={() => {
                                  setDefaultModel(m.id);
                                  setModelSelectorOpen(false);
                                }}
                              >
                                <ModelSelectorLogo provider={m.provider} />
                                <ModelSelectorName>{m.name}</ModelSelectorName>
                                {defaultModel === m.id && (
                                  <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                                )}
                              </ModelSelectorItem>
                            ))}
                          </ModelSelectorGroup>
                          <ModelSelectorSeparator />
                        </>
                      )}
                      {modelGroups.providerGroups.map((provider) => (
                        <ModelSelectorGroup key={provider.provider} heading={provider.provider}>
                          {provider.models.map((m) => (
                            <ModelSelectorItem
                              key={m.id}
                              value={m.id}
                              onSelect={() => {
                                setDefaultModel(m.id);
                                setModelSelectorOpen(false);
                              }}
                            >
                              <ModelSelectorLogo provider={provider.provider} />
                              <ModelSelectorName>{m.name}</ModelSelectorName>
                              {defaultModel === m.id && (
                                <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                              )}
                            </ModelSelectorItem>
                          ))}
                        </ModelSelectorGroup>
                      ))}
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              </MetadataRow>
              <MetadataRow label="Visibility">
                <PersonaVisibilityControl
                  value={visibility}
                  onChange={setVisibility}
                  disabled={!canEdit}
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
              {!isNew && persona && (
                <>
                  <MetadataRow label="Files">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">
                      {persona.files?.length ?? persona.fileCount ?? 0}
                    </span>
                  </MetadataRow>
                  <MetadataRow label="Updated">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">
                      {new Date(persona.updatedAt).toLocaleDateString()}
                    </span>
                  </MetadataRow>
                </>
              )}
            </MetadataSection>

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
              </MetadataSection>
            )}
          </div>
        }
      >
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PersonaDetailTab)}>
          <TabsList>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
          </TabsList>

          <TabsContent value="files">
            <div className="space-y-5">
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    instructions.md
                  </h2>
                </div>
                <MarkdownEditor
                  value={instructions}
                  onChange={setInstructions}
                  placeholder="Write persona instructions in markdown..."
                  readOnly={!canEdit}
                  minHeightClassName="min-h-[24rem]"
                />
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Additional Files
                  </h2>
                  {canEdit && (
                    <Button type="button" variant="secondary" onClick={addFile}>
                      Add File
                    </Button>
                  )}
                </div>

                {files.length === 0 ? (
                  <EmptyTabMessage>No additional files.</EmptyTabMessage>
                ) : (
                  <div className="space-y-4">
                    {files.map((file, index) => (
                      <div
                        key={index}
                        className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
                      >
                        <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_88px_auto]">
                          <Input
                            value={file.filename}
                            onChange={(e) => updateFile(index, { filename: e.target.value })}
                            placeholder="supporting-notes.md"
                            className="text-sm"
                            disabled={!canEdit}
                          />
                          <Input
                            type="number"
                            value={file.sortOrder}
                            onChange={(e) => updateFile(index, { sortOrder: Number.parseInt(e.target.value, 10) || 0 })}
                            className="text-sm"
                            min={0}
                            title="Sort order"
                            disabled={!canEdit}
                          />
                          {canEdit && (
                            <Button type="button" variant="secondary" onClick={() => removeFile(index)}>
                              Remove
                            </Button>
                          )}
                        </div>
                        <MarkdownEditor
                          value={file.content}
                          onChange={(value) => updateFile(index, { content: value })}
                          placeholder="Write supporting markdown..."
                          readOnly={!canEdit}
                          minHeightClassName="min-h-[16rem]"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </TabsContent>

          <TabsContent value="skills">
            {isNew ? (
              <EmptyTabMessage>Save the persona first to attach skills.</EmptyTabMessage>
            ) : (
              <SkillPicker
                attachedSkills={attachedSkills}
                onAttach={(skillId) => attachSkill.mutate({ personaId: id, skillId })}
                onDetach={(skillId) => detachSkill.mutate({ personaId: id, skillId })}
                readOnly={!canEdit}
              />
            )}
          </TabsContent>

          <TabsContent value="tools">
            {isNew ? (
              <EmptyTabMessage>Save the persona first to configure tools.</EmptyTabMessage>
            ) : (
              <PersonaToolPicker tools={toolEntries} onChange={handleToolsChange} readOnly={!canEdit} />
            )}
          </TabsContent>
        </Tabs>
      </SplitDetailLayout>
    </form>
  );
}

function PersonaVisibilityControl({
  value,
  onChange,
  disabled,
}: {
  value: PersonaVisibility;
  onChange: (value: PersonaVisibility) => void;
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

function getPersonaOwnerInfo(persona: AgentPersona | undefined, user: User | null, isNew: boolean) {
  if (isNew) {
    return {
      ownerId: user?.id ?? null,
      ownerName: user?.name ?? null,
      ownerEmail: user?.email ?? null,
      ownerAvatarUrl: user?.avatarUrl ?? null,
    };
  }
  return {
    ownerId: persona?.createdBy ?? null,
    ownerName: persona?.creatorName ?? null,
    ownerEmail: null,
    ownerAvatarUrl: null,
  };
}

function EmptyTabMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
      {children}
    </p>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PersonaDetailSkeleton() {
  const pulse = 'animate-pulse rounded bg-neutral-100 dark:bg-neutral-700';
  return (
    <SplitDetailLayout
      backTo="/settings/personas"
      backLabel="Back to Personas"
      title="Loading…"
      metadata={
        <div className="space-y-6">
          <div className="space-y-3">
            <div className={`h-3 w-20 ${pulse}`} />
            <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
              <div className={`h-9 ${pulse}`} />
              <div className={`h-9 ${pulse}`} />
            </div>
            <div className={`h-24 ${pulse}`} />
            <div className={`h-9 ${pulse}`} />
            <div className={`h-9 ${pulse}`} />
          </div>
          <div className="space-y-3">
            <div className={`h-3 w-20 ${pulse}`} />
            <div className="flex items-center gap-3">
              <div className={`h-8 w-8 rounded-full ${pulse}`} />
              <div className={`h-4 w-32 ${pulse}`} />
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className={`h-9 w-48 ${pulse}`} />
        <div className={`h-[30rem] ${pulse}`} />
      </div>
    </SplitDetailLayout>
  );
}
