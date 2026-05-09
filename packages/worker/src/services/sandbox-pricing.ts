// Modal sandbox pricing rates (per second)
export const SANDBOX_CPU_RATE_PER_CORE_SEC = 0.00003942;
export const SANDBOX_MEM_RATE_PER_GIB_SEC = 0.00000672;

// Fallback defaults when user hasn't configured custom resources
export const DEFAULT_CPU_CORES = 1.5;
export const DEFAULT_MEMORY_GIB = 1;

export function computeSandboxCost(
  activeSeconds: number,
  cpuCores = DEFAULT_CPU_CORES,
  memoryGiB = DEFAULT_MEMORY_GIB,
): number {
  return activeSeconds * (cpuCores * SANDBOX_CPU_RATE_PER_CORE_SEC + memoryGiB * SANDBOX_MEM_RATE_PER_GIB_SEC);
}
