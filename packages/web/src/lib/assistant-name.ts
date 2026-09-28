/** Display names never substitute the owning team's name for the assistant. */
export function orchestratorName(name: string | null | undefined): string {
  return name?.trim() || "Default Orchestrator";
}
