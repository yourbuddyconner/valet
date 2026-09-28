/**
 * One mark per node type, shared by the palette rail and the canvas card.
 *
 * The rail and the card must use the SAME mark. After a click the reader
 * has to see that the button they pressed became that card, and the
 * small-caps type label does not carry that on its own — it is the first
 * thing to become unreadable when the canvas is zoomed out to fit a large
 * graph, while a 14px glyph survives.
 *
 * Silhouettes are chosen to differ from each other, not to be literal: at
 * canvas scale the reader distinguishes shapes, not subjects.
 */
import {
  Bot,
  Braces,
  CircleStop,
  Repeat,
  Sparkles,
  Split,
  SquareTerminal,
  Timer,
  UserCheck,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { DagNodeType } from "../editor-model";

export const NODE_ICON: Record<DagNodeType, LucideIcon> = {
  trigger: Zap,
  set: Braces,
  if: Split,
  wait: Timer,
  approval: UserCheck,
  session: SquareTerminal,
  stop: CircleStop,
  foreach: Repeat,
  llm: Sparkles,
  thread: Bot,
  tool: Wrench,
  workflow: Workflow,
};
