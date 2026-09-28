import type { OwnerFilter } from "~/api/client";
import { useTeams } from "~/api/settings";

/** Labels the selected owner without loading an assistant identity. */
export function useWorkspaceName(owner?: OwnerFilter): string {
  const teams = useTeams();
  if (owner?.ownerType === "team") {
    return teams.data?.teams.find(team => team.id === owner.ownerId)?.name ?? "this team workspace";
  }
  return "your personal workspace";
}
