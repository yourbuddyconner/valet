import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AgentPersona, PersonaVisibility } from '@/api/types';
import { useAvailableModels } from '@/api/sessions';

interface PersonaEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  persona?: AgentPersona | null;
  onSave: (data: PersonaFormData) => void;
  isSaving?: boolean;
}

export interface PersonaFormData {
  name: string;
  description: string;
  icon: string;
  defaultModel?: string;
  visibility: PersonaVisibility;
  files: { filename: string; content: string; sortOrder: number }[];
}

export function PersonaEditor({ open, onOpenChange, persona, onSave, isSaving }: PersonaEditorProps) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [icon, setIcon] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState('');
  const [visibility, setVisibility] = React.useState<PersonaVisibility>('shared');
  const [instructions, setInstructions] = React.useState('');
  const [files, setFiles] = React.useState<{ filename: string; content: string; sortOrder: number }[]>([]);
  const { data: availableModels } = useAvailableModels();

  // Populate form when editing — separate the primary instructions.md from additional files
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
    } else {
      setName('');
      setDescription('');
      setIcon('');
      setDefaultModel('');
      setVisibility('shared');
      setInstructions('');
      setFiles([]);
    }
  }, [persona, open]);

  const addFile = () => {
    setFiles([...files, { filename: `instructions-${files.length + 1}.md`, content: '', sortOrder: files.length }]);
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const updateFile = (index: number, updates: Partial<{ filename: string; content: string; sortOrder: number }>) => {
    setFiles(files.map((f, i) => (i === index ? { ...f, ...updates } : f)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Merge the instructions textarea as instructions.md (sort order 0) with any additional files
    const allFiles = [
      ...(instructions.trim()
        ? [{ filename: 'instructions.md', content: instructions, sortOrder: 0 }]
        : []),
      ...files,
    ];
    onSave({ name, description, icon, defaultModel: defaultModel || undefined, visibility, files: allFiles });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{persona ? 'Edit Persona' : 'Create Persona'}</DialogTitle>
            <DialogDescription>
              Define agent behavior with persona instructions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
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
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Code Reviewer"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Description
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Reviews code for quality and best practices"
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

            {/* Instructions textarea */}
            <div>
              <label className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Instructions
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Write persona instructions in markdown...&#10;&#10;Example: You are a code reviewer. Focus on security, performance, and readability."
                rows={6}
                className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
              <p className="mt-1 text-xs text-neutral-400">
                Markdown instructions injected as the primary persona file
              </p>
            </div>

            {/* Additional files section */}
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

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSaving}>
              {isSaving ? 'Saving...' : persona ? 'Save Changes' : 'Create Persona'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
