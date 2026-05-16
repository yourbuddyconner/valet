import { createFileRoute } from '@tanstack/react-router';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import type { WorkflowData } from '@/api/workflows';

export const Route = createFileRoute('/_dev/workflow-diagram-preview')({
  component: Preview,
});

const sample: WorkflowData = {
  id: 'preview',
  name: 'CI Overnight Digest',
  steps: [
    { id: 'list_runs', name: 'List overnight runs', type: 'bash', command: 'gh run list --branch main --limit 20' },
    {
      id: 'gate',
      name: 'Any failures?',
      type: 'conditional',
      condition: 'outputs.list_runs.failed > 0',
      then: [
        { id: 'summarize', name: 'Summarize failures', type: 'agent_message', content: 'For each failed run, list name + link' },
        { id: 'post_fail', name: 'Post failures to Slack', type: 'agent_message', content: 'Channel: #engineering' },
      ],
      else: [
        { id: 'post_green', name: 'Post all-green', type: 'agent_message', content: '✅ Overnight CI: all green' },
      ],
    },
  ],
};

function Preview() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">View mode</h1>
      <div className="h-[600px]">
        <WorkflowDiagram workflow={sample} mode="view" />
      </div>

      <h1 className="text-xl font-semibold mt-8 mb-4">Runtime mode (mid-run)</h1>
      <div className="h-[600px]">
        <WorkflowDiagram
          workflow={sample}
          mode="runtime"
          currentStepId="summarize"
          runtimeStatus={{
            list_runs: 'completed',
            gate: 'completed',
            summarize: 'running',
            post_fail: 'pending',
            post_green: 'skipped',
          }}
        />
      </div>
    </div>
  );
}
