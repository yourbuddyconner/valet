import type { SessionLifecycleStatus } from '../../durable-objects/session-state.js';

export type SandboxRuntimeState = 'starting' | 'running' | 'hibernating' | 'hibernated' | 'restoring' | 'stopped' | 'error';
export type AgentRuntimeState = 'starting' | 'busy' | 'idle' | 'queued' | 'sleeping' | 'standby' | 'stopped' | 'error';
export type JointRuntimeState = 'starting' | 'running_busy' | 'running_idle' | 'queued' | 'waking' | 'sleeping' | 'standby' | 'stopped' | 'error';

export function deriveRuntimeStates(args: {
  lifecycleStatus: string;
  sandboxId?: string | null;
  runnerConnected: boolean;
  runnerBusy: boolean;
  queuedPrompts: number;
}): {
  sandboxState: SandboxRuntimeState;
  agentState: AgentRuntimeState;
  jointState: JointRuntimeState;
} {
  const lifecycle = args.lifecycleStatus as SessionLifecycleStatus;
  const hasSandbox = !!args.sandboxId;
  const hasQueue = args.queuedPrompts > 0;

  const sandboxState: SandboxRuntimeState = (() => {
    if (lifecycle === 'error') return 'error';
    if (lifecycle === 'terminated' || lifecycle === 'archived') return 'stopped';
    if (lifecycle === 'hibernating') return 'hibernating';
    if (lifecycle === 'hibernated') return 'hibernated';
    if (lifecycle === 'restoring') return 'restoring';
    if (lifecycle === 'initializing' || lifecycle === 'waiting_runner') return 'starting';
    if (lifecycle === 'recovering' || lifecycle === 'backoff') return 'error';
    if (hasSandbox) return 'running';
    if (hasQueue) return 'restoring';
    return 'stopped';
  })();

  const agentState: AgentRuntimeState = (() => {
    if (lifecycle === 'error') return 'error';
    if (lifecycle === 'terminated' || lifecycle === 'archived') return 'stopped';
    if (lifecycle === 'hibernating' || lifecycle === 'hibernated') return 'sleeping';
    if (lifecycle === 'recovering' || lifecycle === 'backoff') return 'error';
    if (lifecycle === 'initializing' || lifecycle === 'waiting_runner' || lifecycle === 'restoring') {
      return hasQueue ? 'queued' : 'starting';
    }
    if (hasQueue && !args.runnerConnected) return 'queued';
    if (args.runnerConnected && args.runnerBusy) return 'busy';
    if (hasQueue) return 'queued';
    if (hasSandbox && args.runnerConnected) return 'idle';
    if (hasSandbox && !args.runnerConnected) return 'standby';
    return 'standby';
  })();

  const jointState: JointRuntimeState = (() => {
    if (agentState === 'error') return 'error';
    if (agentState === 'stopped') return 'stopped';
    if (agentState === 'sleeping') return 'sleeping';
    if (sandboxState === 'starting') return 'starting';
    if (sandboxState === 'restoring') return hasQueue ? 'waking' : 'starting';
    if (agentState === 'busy') return 'running_busy';
    if (agentState === 'idle') return 'running_idle';
    if (agentState === 'queued') return hasSandbox ? 'queued' : 'waking';
    if (agentState === 'standby') return 'standby';
    return 'starting';
  })();

  return { sandboxState, agentState, jointState };
}
