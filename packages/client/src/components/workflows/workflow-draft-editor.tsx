import { useEffect, useState } from 'react';
import type { WorkflowData } from '@/api/workflows';
import { WorkflowDiagram } from './workflow-diagram';

interface Props {
  prompt: string;
  workflow: WorkflowData;
  onRegenerate: () => void;
  onEditPrompt: (p: string) => void;
  onJsonToggle: () => void;
  jsonOpen: boolean;
  onNodeClick: (stepId: string) => void;
  onRefine: (text: string) => void;
  refining: boolean;
}

export function WorkflowDraftEditor({
  prompt,
  workflow,
  onRegenerate,
  onEditPrompt,
  onJsonToggle,
  jsonOpen,
  onNodeClick,
  onRefine,
  refining,
}: Props) {
  const [refineText, setRefineText] = useState('');
  const [editPrompt, setEditPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(prompt);

  useEffect(() => {
    if (editPrompt) setPromptDraft(prompt);
  }, [editPrompt, prompt]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 bg-white border-b border-neutral-200">
        <div className="text-[11px] text-neutral-500 tracking-wider mb-1">YOUR PROMPT</div>
        {editPrompt ? (
          <textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            onBlur={() => {
              onEditPrompt(promptDraft);
              setEditPrompt(false);
            }}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            autoFocus
          />
        ) : (
          <div className="bg-indigo-50 border-l-4 border-indigo-500 px-3 py-2 rounded text-sm text-neutral-800">
            {prompt}
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button
            onClick={onRegenerate}
            disabled={refining}
            className="text-xs text-indigo-600 border border-indigo-600 px-3 py-1 rounded-md hover:bg-indigo-50 disabled:opacity-50"
          >
            ↻ Regenerate
          </button>
          <button
            onClick={() => setEditPrompt(true)}
            className="text-xs text-neutral-600 border border-neutral-300 px-3 py-1 rounded-md hover:bg-neutral-50"
          >
            ✎ Edit prompt
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-6 bg-neutral-50">
          <div className="h-full">
            <WorkflowDiagram workflow={workflow} mode="edit" onNodeClick={onNodeClick} />
          </div>
        </div>
        {jsonOpen && (
          <aside className="w-96 bg-white border-l border-neutral-200 p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Workflow JSON</h3>
              <button onClick={onJsonToggle} className="text-xs text-neutral-500">
                close
              </button>
            </div>
            <pre className="text-xs bg-neutral-50 border border-neutral-200 rounded p-3 overflow-x-auto">
              {JSON.stringify(workflow, null, 2)}
            </pre>
          </aside>
        )}
      </div>

      <div className="px-6 py-3 bg-white border-t border-neutral-200 flex gap-2">
        <input
          type="text"
          value={refineText}
          onChange={(e) => setRefineText(e.target.value)}
          placeholder="Refine — e.g. 'add a step that pings on-call if more than 3 failed'"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && refineText.trim()) {
              onRefine(refineText.trim());
              setRefineText('');
            }
          }}
        />
        <button
          onClick={() => {
            if (refineText.trim()) {
              onRefine(refineText.trim());
              setRefineText('');
            }
          }}
          disabled={refining || !refineText.trim()}
          className="px-4 py-2 bg-neutral-900 text-white rounded-md text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
        <button
          onClick={onJsonToggle}
          className="px-3 py-2 border border-neutral-300 rounded-md text-sm"
        >
          {'{ } JSON'}
        </button>
      </div>
    </div>
  );
}
