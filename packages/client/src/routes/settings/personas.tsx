import * as React from 'react';
import { createFileRoute, useNavigate, Outlet, useMatch } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { usePersonas, useDeletePersona } from '@/api/personas';
import { useAuthStore } from '@/stores/auth';
import type { AgentPersona } from '@/api/types';

export const Route = createFileRoute('/settings/personas')({
  component: PersonasLayout,
});

function PersonasLayout() {
  const childMatch = useMatch({ from: '/settings/personas/$id', shouldThrow: false });

  if (childMatch) {
    return <Outlet />;
  }

  return <PersonasListPage />;
}

function PersonasListPage() {
  const { data: personas, isLoading } = usePersonas();
  const deletePersona = useDeletePersona();
  const navigate = useNavigate();

  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  const user = useAuthStore((s) => s.user);

  const handleCreate = () => {
    navigate({ to: '/settings/personas/$id', params: { id: 'new' } });
  };

  const handleEdit = (id: string) => {
    navigate({ to: '/settings/personas/$id', params: { id } });
  };

  const handleDelete = (id: string) => {
    deletePersona.mutate(id, {
      onSuccess: () => setConfirmDelete(null),
    });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Agent Personas"
        description="Define agent behavior with persona instruction files"
        actions={
          <Button onClick={handleCreate}>
            New Persona
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-700" />
          ))}
        </div>
      ) : !personas?.length ? (
        <div className="rounded-lg border border-dashed border-neutral-200 px-6 py-12 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No personas yet. Create one to customize agent behavior.
          </p>
          <Button className="mt-4" onClick={handleCreate}>
            Create Your First Persona
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {personas.map((persona) => (
            <PersonaCard
              key={persona.id}
              persona={persona}
              isOwn={persona.createdBy === user?.id}
              isAdmin={user?.role === 'admin'}
              onEdit={() => handleEdit(persona.id)}
              onDelete={() =>
                confirmDelete === persona.id
                  ? handleDelete(persona.id)
                  : setConfirmDelete(persona.id)
              }
              isConfirmingDelete={confirmDelete === persona.id}
              onCancelDelete={() => setConfirmDelete(null)}
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function PersonaCard({
  persona,
  isOwn,
  isAdmin,
  onEdit,
  onDelete,
  isConfirmingDelete,
  onCancelDelete,
}: {
  persona: AgentPersona;
  isOwn: boolean;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  isConfirmingDelete: boolean;
  onCancelDelete: () => void;
}) {
  const canEdit = isOwn || isAdmin;

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          {persona.icon && <span className="text-xl">{persona.icon}</span>}
          <div>
            <h3 className="font-medium text-neutral-900 dark:text-neutral-100">
              {persona.name}
            </h3>
            <p className="text-xs text-neutral-400">{persona.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {persona.isDefault && <Badge>default</Badge>}
          <Badge variant="secondary">
            {persona.visibility}
          </Badge>
        </div>
      </div>

      {persona.description && (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {persona.description}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-neutral-400">
          {persona.fileCount ?? 0} file{(persona.fileCount ?? 0) !== 1 ? 's' : ''}
          {persona.creatorName && (
            <> &middot; by {persona.creatorName}</>
          )}
        </span>
        {persona.defaultModel && (
          <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            {persona.defaultModel}
          </span>
        )}

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onEdit}>
              Edit
            </Button>
            {isConfirmingDelete ? (
              <>
                <Button variant="secondary" onClick={onDelete}>
                  Confirm
                </Button>
                <Button variant="secondary" onClick={onCancelDelete}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={onDelete}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
