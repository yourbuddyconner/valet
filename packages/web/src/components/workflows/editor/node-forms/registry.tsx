/**
 * Node-type → form dispatch. One form component per `WorkflowNode` variant,
 * each in its own file (`./llm-form.tsx` etc.) — mirrors the tool-renderer
 * registry pattern (`session/tool-renderers/index.ts`): new node type, new
 * form file, list it here.
 */
import type { WorkflowNode } from "@valet/workflow";
import { ApprovalForm } from "./approval-form";
import { ForeachForm } from "./foreach-form";
import { IfForm } from "./if-form";
import { LlmForm } from "./llm-form";
import { ThreadForm } from "./thread-form";
import { SessionForm } from "./session-form";
import { SetForm } from "./set-form";
import { StopForm } from "./stop-form";
import { ToolForm } from "./tool-form";
import { TriggerForm } from "./trigger-form";
import { WaitForm } from "./wait-form";
import { WorkflowCallForm } from "./workflow-call-form";

/** `key={node.id}` at the call site (see `Inspector`) remounts this on
 * node-selection change, so every form's local state (`JsonTextarea`
 * buffers, etc.) resets instead of leaking across nodes. */
export function NodeForm({
  node,
  onChange,
}: {
  node: WorkflowNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  switch (node.type) {
    case "trigger":
      return <TriggerForm node={node} onChange={onChange} />;
    case "set":
      return <SetForm node={node} onChange={onChange} />;
    case "if":
      return <IfForm node={node} onChange={onChange} />;
    case "wait":
      return <WaitForm node={node} onChange={onChange} />;
    case "approval":
      return <ApprovalForm node={node} onChange={onChange} />;
    case "session":
      return <SessionForm node={node} onChange={onChange} />;
    case "stop":
      return <StopForm node={node} onChange={onChange} />;
    case "foreach":
      return <ForeachForm node={node} onChange={onChange} />;
    case "llm":
      return <LlmForm node={node} onChange={onChange} />;
    case "thread":
      return <ThreadForm node={node} onChange={onChange} />;
    case "tool":
      return <ToolForm node={node} onChange={onChange} />;
    case "workflow":
      return <WorkflowCallForm node={node} onChange={onChange} />;
  }
}
