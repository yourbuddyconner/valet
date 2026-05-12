import type { SessionStatus } from '@/api/types';

export type SessionLifecycleStatus = SessionStatus;
export type SandboxRuntimeState =
  | 'starting'
  | 'running'
  | 'hibernating'
  | 'hibernated'
  | 'restoring'
  | 'stopped'
  | 'error';
export type AgentRuntimeState =
  | 'starting'
  | 'busy'
  | 'idle'
  | 'queued'
  | 'sleeping'
  | 'standby'
  | 'stopped'
  | 'error';
export type JointRuntimeState =
  | 'starting'
  | 'running_busy'
  | 'running_idle'
  | 'queued'
  | 'waking'
  | 'sleeping'
  | 'standby'
  | 'stopped'
  | 'error';

const LIFECYCLE_VALUES: SessionLifecycleStatus[] = [
  'initializing',
  'waiting_runner',
  'recovering',
  'backoff',
  'running',
  'idle',
  'hibernating',
  'hibernated',
  'restoring',
  'terminated',
  'archived',
  'error',
];

const SANDBOX_VALUES: SandboxRuntimeState[] = [
  'starting',
  'running',
  'hibernating',
  'hibernated',
  'restoring',
  'stopped',
  'error',
];

const AGENT_VALUES: AgentRuntimeState[] = [
  'starting',
  'busy',
  'idle',
  'queued',
  'sleeping',
  'standby',
  'stopped',
  'error',
];

const JOINT_VALUES: JointRuntimeState[] = [
  'starting',
  'running_busy',
  'running_idle',
  'queued',
  'waking',
  'sleeping',
  'standby',
  'stopped',
  'error',
];

interface DeriveRuntimeStatesArgs {
  lifecycleStatus?: string | null;
  sandboxId?: string | null;
  runnerConnected?: boolean;
  runnerBusy?: boolean;
  queuedPrompts?: number;
}

function isMember<T extends string>(value: string | null | undefined, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function isAgentRuntimeState(value: string | null | undefined): value is AgentRuntimeState {
  return isMember(value, AGENT_VALUES);
}

export function isSandboxRuntimeState(value: string | null | undefined): value is SandboxRuntimeState {
  return isMember(value, SANDBOX_VALUES);
}

export function isJointRuntimeState(value: string | null | undefined): value is JointRuntimeState {
  return isMember(value, JOINT_VALUES);
}

function normalizeLifecycleStatus(value: string | null | undefined): SessionLifecycleStatus {
  if (isMember(value, LIFECYCLE_VALUES)) return value;
  return 'terminated';
}

export function deriveRuntimeStates(args: DeriveRuntimeStatesArgs): {
  lifecycleStatus: SessionLifecycleStatus;
  sandboxState: SandboxRuntimeState;
  agentState: AgentRuntimeState;
  jointState: JointRuntimeState;
} {
  const lifecycleStatus = normalizeLifecycleStatus(args.lifecycleStatus);
  const hasSandbox = !!args.sandboxId;
  const hasQueue = (args.queuedPrompts ?? 0) > 0;
  const runnerConnected = args.runnerConnected === true;
  const runnerBusy = args.runnerBusy === true;

  const sandboxState: SandboxRuntimeState = (() => {
    if (lifecycleStatus === 'error') return 'error';
    if (lifecycleStatus === 'terminated' || lifecycleStatus === 'archived') return 'stopped';
    if (lifecycleStatus === 'hibernating') return 'hibernating';
    if (lifecycleStatus === 'hibernated') return 'hibernated';
    if (lifecycleStatus === 'restoring') return 'restoring';
    if (lifecycleStatus === 'initializing' || lifecycleStatus === 'waiting_runner') return 'starting';
    if (lifecycleStatus === 'recovering' || lifecycleStatus === 'backoff') return 'error';
    if (hasSandbox) return 'running';
    if (hasQueue) return 'restoring';
    return 'stopped';
  })();

  const agentState: AgentRuntimeState = (() => {
    if (lifecycleStatus === 'error') return 'error';
    if (lifecycleStatus === 'terminated' || lifecycleStatus === 'archived') return 'stopped';
    if (lifecycleStatus === 'hibernating' || lifecycleStatus === 'hibernated') return 'sleeping';
    if (lifecycleStatus === 'recovering' || lifecycleStatus === 'backoff') return 'error';
    if (lifecycleStatus === 'initializing' || lifecycleStatus === 'waiting_runner' || lifecycleStatus === 'restoring') {
      return hasQueue ? 'queued' : 'starting';
    }
    if (runnerConnected && runnerBusy) return 'busy';
    if (hasQueue) return 'queued';
    if (hasSandbox && runnerConnected) return 'idle';
    if (hasSandbox && !runnerConnected) return 'standby';
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

  return {
    lifecycleStatus,
    sandboxState,
    agentState,
    jointState,
  };
}
