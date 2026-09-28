import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { qkWorkflows } from "./workflows";
const key = ["org", "linear"] as const;
export function useLinearConnection() {
  return useQuery({ queryKey: key, queryFn: api.getLinearConnection });
}
export function useConnectLinear() {
  return useMutation({ mutationFn: api.postLinearConnect, onSuccess: ({ url }) => window.location.assign(url) });
}
export function useDisconnectLinear() {
  const client = useQueryClient();
  return useMutation({ mutationFn: api.deleteLinearConnection, onSuccess: async () => {
    await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: qkWorkflows.triggerCatalog() })]);
  } });
}
