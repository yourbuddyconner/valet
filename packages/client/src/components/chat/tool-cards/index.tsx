import { lazy, Suspense } from 'react';
import type { ToolCallData } from './types';
import { useState } from 'react';
import { SummaryToolCard } from './summary-card';
import { ToolCardExpansionIntentContext } from './tool-card-shell';

const BashCard = lazy(() => import('./bash-card').then((m) => ({ default: m.BashCard })));
const GlobCard = lazy(() => import('./glob-card').then((m) => ({ default: m.GlobCard })));
const GrepCard = lazy(() => import('./grep-card').then((m) => ({ default: m.GrepCard })));
const TodoWriteCard = lazy(() => import('./todo-card').then((m) => ({ default: m.TodoWriteCard })));
const TodoReadCard = lazy(() => import('./todo-card').then((m) => ({ default: m.TodoReadCard })));
const ListCard = lazy(() => import('./list-card').then((m) => ({ default: m.ListCard })));
const QuestionCard = lazy(() => import('./question-card').then((m) => ({ default: m.QuestionCard })));
const WebFetchCard = lazy(() => import('./webfetch-card').then((m) => ({ default: m.WebFetchCard })));
const LspCard = lazy(() => import('./lsp-card').then((m) => ({ default: m.LspCard })));
const SkillCard = lazy(() => import('./skill-card').then((m) => ({ default: m.SkillCard })));
const SpawnSessionCard = lazy(() => import('./spawn-session-card').then((m) => ({ default: m.SpawnSessionCard })));
const SendMessageCard = lazy(() => import('./session-message-card').then((m) => ({ default: m.SendMessageCard })));
const ReadMessagesCard = lazy(() => import('./session-message-card').then((m) => ({ default: m.ReadMessagesCard })));
const TaskCard = lazy(() => import('./task-card').then((m) => ({ default: m.TaskCard })));
const ImageCard = lazy(() => import('./image-card').then((m) => ({ default: m.ImageCard })));
const GenericCard = lazy(() => import('./generic-card').then((m) => ({ default: m.GenericCard })));
const ReadCard = lazy(() => import('./read-card').then((m) => ({ default: m.ReadCard })));
const EditCard = lazy(() => import('./edit-card').then((m) => ({ default: m.EditCard })));
const WriteCard = lazy(() => import('./write-card').then((m) => ({ default: m.WriteCard })));
const PatchCard = lazy(() => import('./patch-card').then((m) => ({ default: m.PatchCard })));

export type { ToolCallData, ToolCallStatus } from './types';

export function shouldShowToolCardSummary({
  engaged,
  initiallyEngaged = false,
}: {
  engaged: boolean;
  initiallyEngaged?: boolean;
}) {
  return !(engaged || initiallyEngaged);
}

/** Route a tool call to its specialized card component */
export function ToolCard({
  tool,
  initiallyEngaged = false,
}: {
  tool: ToolCallData;
  initiallyEngaged?: boolean;
}) {
  const alwaysOpen = isAlwaysOpenTool(tool.toolName);
  const [engaged, setEngaged] = useState(false);

  if (!alwaysOpen && shouldShowToolCardSummary({ engaged, initiallyEngaged })) {
    return <SummaryToolCard tool={tool} onExpand={() => setEngaged(true)} />;
  }

  const card = resolveToolCard(tool);
  return (
    <Suspense fallback={<SummaryToolCard tool={tool} loading />}>
      <ToolCardExpansionIntentContext.Provider value={true}>
        {card}
      </ToolCardExpansionIntentContext.Provider>
    </Suspense>
  );
}

const ALWAYS_OPEN_TOOLS = new Set(['send_image', 'screenshot']);

function isAlwaysOpenTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return ALWAYS_OPEN_TOOLS.has(name);
}

function resolveToolCard(tool: ToolCallData) {
  const name = tool.toolName.toLowerCase();

  // Exact matches
  switch (name) {
    case 'read':
    case 'file_read':
    case 'read_file':
      return <ReadCard tool={tool} />;

    case 'edit':
    case 'file_edit':
    case 'edit_file':
      return <EditCard tool={tool} />;

    case 'write':
    case 'file_write':
    case 'write_file':
    case 'create_file':
      return <WriteCard tool={tool} />;

    case 'bash':
    case 'shell':
    case 'execute':
    case 'run':
      return <BashCard tool={tool} />;

    case 'glob':
    case 'find_files':
    case 'file_search':
      return <GlobCard tool={tool} />;

    case 'grep':
    case 'search':
    case 'ripgrep':
    case 'content_search':
      return <GrepCard tool={tool} />;

    case 'todowrite':
    case 'todo_write':
    case 'write_todos':
      return <TodoWriteCard tool={tool} />;

    case 'todoread':
    case 'todo_read':
    case 'read_todos':
    case 'list_todos':
      return <TodoReadCard tool={tool} />;

    case 'ls':
    case 'list':
    case 'list_dir':
    case 'list_directory':
      return <ListCard tool={tool} />;

    case 'question':
    case 'ask':
    case 'ask_user':
      return <QuestionCard tool={tool} />;

    case 'webfetch':
    case 'web_fetch':
    case 'fetch_url':
      return <WebFetchCard tool={tool} />;

    case 'patch':
    case 'apply_patch':
      return <PatchCard tool={tool} />;

    case 'lsp':
    case 'language_server':
      return <LspCard tool={tool} />;

    case 'skill':
    case 'load_skill':
      return <SkillCard tool={tool} />;

    case 'task':
    case 'subagent':
      return <TaskCard tool={tool} />;

    case 'send_image':
    case 'screenshot':
      return <ImageCard tool={tool} />;

    case 'spawn_session':
      return <SpawnSessionCard tool={tool} />;

    case 'send_message':
      return <SendMessageCard tool={tool} />;

    case 'read_messages':
      return <ReadMessagesCard tool={tool} />;
  }

  // Fuzzy matches for tools with prefixes like "mcp__ide__" or "namespace.tool"
  const baseName = name.split('__').pop()?.split('.').pop() ?? name;

  switch (baseName) {
    case 'read':
    case 'readfile':
      return <ReadCard tool={tool} />;
    case 'edit':
    case 'editfile':
      return <EditCard tool={tool} />;
    case 'write':
    case 'writefile':
    case 'createfile':
      return <WriteCard tool={tool} />;
    case 'bash':
    case 'shell':
    case 'execute':
    case 'executecode':
      return <BashCard tool={tool} />;
    case 'glob':
    case 'find':
      return <GlobCard tool={tool} />;
    case 'grep':
    case 'search':
      return <GrepCard tool={tool} />;
    case 'todowrite':
      return <TodoWriteCard tool={tool} />;
    case 'todoread':
      return <TodoReadCard tool={tool} />;
    case 'ls':
    case 'list':
      return <ListCard tool={tool} />;
    case 'question':
    case 'ask':
      return <QuestionCard tool={tool} />;
    case 'webfetch':
      return <WebFetchCard tool={tool} />;
    case 'patch':
      return <PatchCard tool={tool} />;
    case 'lsp':
      return <LspCard tool={tool} />;
    case 'skill':
      return <SkillCard tool={tool} />;
    case 'task':
    case 'subagent':
      return <TaskCard tool={tool} />;
    case 'send_image':
    case 'sendimage':
    case 'screenshot':
      return <ImageCard tool={tool} />;
    case 'spawn_session':
    case 'spawnsession':
      return <SpawnSessionCard tool={tool} />;
    case 'send_message':
    case 'sendmessage':
      return <SendMessageCard tool={tool} />;
    case 'read_messages':
    case 'readmessages':
      return <ReadMessagesCard tool={tool} />;
  }

  return <GenericCard tool={tool} />;
}
