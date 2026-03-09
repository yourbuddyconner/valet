import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  AgentPersona,
  PersonaVisibility,
  PersonaToolConfig,
  PersonaSkillAttachment,
} from './types';
import { skillKeys } from './skills';

export const personaKeys = {
  all: ['personas'] as const,
  list: () => [...personaKeys.all, 'list'] as const,
  details: () => [...personaKeys.all, 'detail'] as const,
  detail: (id: string) => [...personaKeys.details(), id] as const,
};

export function usePersonas() {
  return useQuery({
    queryKey: personaKeys.list(),
    queryFn: () => api.get<{ personas: AgentPersona[] }>('/personas'),
    select: (data) => data.personas,
  });
}

export function usePersona(id: string) {
  return useQuery({
    queryKey: personaKeys.detail(id),
    queryFn: () => api.get<{ persona: AgentPersona }>(`/personas/${id}`),
    enabled: !!id,
    select: (data) => data.persona,
  });
}

interface CreatePersonaInput {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  defaultModel?: string;
  visibility?: PersonaVisibility;
  isDefault?: boolean;
  files?: { filename: string; content: string; sortOrder: number }[];
}

export function useCreatePersona() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreatePersonaInput) =>
      api.post<{ persona: AgentPersona }>('/personas', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
    },
  });
}

interface UpdatePersonaInput {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  icon?: string;
  defaultModel?: string;
  visibility?: PersonaVisibility;
  isDefault?: boolean;
}

export function useUpdatePersona() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdatePersonaInput) =>
      api.put<{ ok: boolean }>(`/personas/${id}`, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
      queryClient.invalidateQueries({ queryKey: personaKeys.detail(id) });
    },
  });
}

export function useDeletePersona() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/personas/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
    },
  });
}

export function useUpdatePersonaFiles() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      personaId,
      files,
    }: {
      personaId: string;
      files: { filename: string; content: string; sortOrder: number }[];
    }) => api.put<{ ok: boolean }>(`/personas/${personaId}/files`, files),
    onSuccess: (_, { personaId }) => {
      queryClient.invalidateQueries({ queryKey: personaKeys.detail(personaId) });
    },
  });
}

// --- Persona Tools ---

export function usePersonaTools(personaId: string) {
  return useQuery({
    queryKey: [...personaKeys.detail(personaId), 'tools'] as const,
    queryFn: () =>
      api.get<{ tools: PersonaToolConfig[] }>(`/personas/${personaId}/tools`),
    enabled: !!personaId,
    select: (data) => data.tools,
  });
}

export function useUpdatePersonaTools() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      personaId,
      tools,
    }: {
      personaId: string;
      tools: { service: string; actionId?: string; enabled: boolean }[];
    }) => api.put<{ ok: boolean }>(`/personas/${personaId}/tools`, { tools }),
    onSuccess: (_, { personaId }) => {
      queryClient.invalidateQueries({ queryKey: personaKeys.detail(personaId) });
    },
  });
}

// --- Persona Skills ---

interface PersonaSkillRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source: string;
  visibility: string;
  sortOrder: number;
}

export function usePersonaSkills(personaId: string) {
  return useQuery({
    queryKey: [...personaKeys.detail(personaId), 'skills'] as const,
    queryFn: () =>
      api.get<{ skills: PersonaSkillRow[] }>(
        `/personas/${personaId}/skills`
      ),
    enabled: !!personaId,
    select: (data) => data.skills,
  });
}

export function useAttachSkillToPersona() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      personaId,
      skillId,
      sortOrder,
    }: {
      personaId: string;
      skillId: string;
      sortOrder?: number;
    }) =>
      api.post<{ attachment: PersonaSkillAttachment }>(
        `/personas/${personaId}/skills`,
        { skillId, sortOrder }
      ),
    onSuccess: (_, { personaId }) => {
      queryClient.invalidateQueries({ queryKey: personaKeys.detail(personaId) });
      queryClient.invalidateQueries({ queryKey: skillKeys.all });
    },
  });
}

export function useDetachSkillFromPersona() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      personaId,
      skillId,
    }: {
      personaId: string;
      skillId: string;
    }) => api.delete<{ ok: boolean }>(`/personas/${personaId}/skills/${skillId}`),
    onSuccess: (_, { personaId }) => {
      queryClient.invalidateQueries({ queryKey: personaKeys.detail(personaId) });
      queryClient.invalidateQueries({ queryKey: skillKeys.all });
    },
  });
}
