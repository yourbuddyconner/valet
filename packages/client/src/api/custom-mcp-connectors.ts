import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCustomMcpConnectorRequest,
  CustomMcpConnector,
  UpdateCustomMcpConnectorRequest,
} from '@valet/shared';
import { api } from './client';

export const mcpConnectorKeys = {
  all: ['custom-mcp-connectors'] as const,
  list: () => [...mcpConnectorKeys.all, 'list'] as const,
  detail: (id: string) => [...mcpConnectorKeys.all, 'detail', id] as const,
};

export function useCustomMcpConnectors() {
  return useQuery({
    queryKey: mcpConnectorKeys.list(),
    queryFn: () => api
      .get<{ connectors: CustomMcpConnector[] }>('/admin/mcp-connectors')
      .then((r) => r.connectors),
  });
}

export function useCreateCustomMcpConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCustomMcpConnectorRequest) =>
      api.post<{ connector: CustomMcpConnector }>('/admin/mcp-connectors', data).then((r) => r.connector),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectorKeys.all });
    },
  });
}

export function useUpdateCustomMcpConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCustomMcpConnectorRequest }) =>
      api.put<{ connector: CustomMcpConnector }>(`/admin/mcp-connectors/${id}`, data).then((r) => r.connector),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: mcpConnectorKeys.all });
      queryClient.invalidateQueries({ queryKey: mcpConnectorKeys.detail(id) });
    },
  });
}

export function useDeleteCustomMcpConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/admin/mcp-connectors/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectorKeys.all });
    },
  });
}
