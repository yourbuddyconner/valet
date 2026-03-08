import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DocsRequest = Record<string, unknown>;

export interface ConvertOptions {
  startIndex?: number; // default: 1
  tabId?: string;
  firstHeadingAsTitle?: boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TextRange {
  startIndex: number;
  endIndex: number;
  formatting: FormattingState;
}

interface FormattingState {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
  code?: boolean;
}

interface ParagraphRange {
  startIndex: number;
  endIndex: number;
  namedStyleType?: string;
}

interface ListState {
  type: 'bullet' | 'ordered';
  level: number;
}

interface PendingListItem {
  startIndex: number;
  endIndex?: number;
  nestingLevel: number;
  bulletPreset:
    | 'NUMBERED_DECIMAL_ALPHA_ROMAN'
    | 'BULLET_DISC_CIRCLE_SQUARE'
    | 'BULLET_CHECKBOX';
  taskPrefixProcessed: boolean;
}

interface CodeBlockRange {
  tableStartIndex: number;
  textStartIndex: number;
  textEndIndex: number;
  language?: string;
}

interface TableCellData {
  text: string;
  isHeader: boolean;
  textRanges: {
    startIndex: number;
    endIndex: number;
    formatting: FormattingState;
  }[];
}

interface TableState {
  rows: TableCellData[][];
  currentRow: TableCellData[];
  inHeader: boolean;
  currentCell: TableCellData | null;
}

interface ConversionContext {
  currentIndex: number;
  insertRequests: DocsRequest[];
  formatRequests: DocsRequest[];
  textRanges: TextRange[];
  formattingStack: FormattingState[];
  listStack: ListState[];
  paragraphRanges: ParagraphRange[];
  normalParagraphRanges: { startIndex: number; endIndex: number }[];
  listSpacingRanges: { startIndex: number; endIndex: number }[];
  pendingListItems: PendingListItem[];
  openListItemStack: number[];
  hrRanges: { startIndex: number; endIndex: number }[];
  codeBlockRanges: CodeBlockRange[];
  tableState?: TableState;
  inTableCell: boolean;
  tabId?: string;
  currentParagraphStart?: number;
  currentHeadingLevel?: number;
  titleConsumed: boolean;
  firstHeadingAsTitle: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_FONT_FAMILY = 'Roboto Mono';
const CODE_TEXT_HEX = '#188038';
const CODE_BACKGROUND_HEX = '#F1F3F4';

// Code block (table-based) visual constants
const CODE_BLOCK_BG_RGB = { red: 0.937, green: 0.945, blue: 0.953 }; // #EFF1F3
const CODE_BLOCK_BORDER_RGB = { red: 0.855, green: 0.863, blue: 0.878 }; // #DADCE0

// Google Docs API inserts a newline before insertTable requests.
// For a 1x1 table at index T:
//   T     -> paragraph break ("\n") auto-inserted
//   T+1   -> table.startIndex
//   T+2   -> tableRow.startIndex
//   T+3   -> tableCell.startIndex
//   T+4   -> paragraph.startIndex (cell content insertion point)
//   T+6   -> table.endIndex
const CELL_CONTENT_OFFSET = 4;
const EMPTY_1x1_TABLE_SIZE = 6;

// ---------------------------------------------------------------------------
// Hex → RGB helper
// ---------------------------------------------------------------------------

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

function hexToRgbColor(hex: string): RgbColor | null {
  if (!hex) return null;
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (isNaN(n)) return null;
  return {
    red: ((n >> 16) & 255) / 255,
    green: ((n >> 8) & 255) / 255,
    blue: (n & 255) / 255,
  };
}

// ---------------------------------------------------------------------------
// Request builder helpers (inlined from reference's googleDocsApiHelpers)
// ---------------------------------------------------------------------------

interface TextStyleArgs {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  foregroundColor?: string;
  backgroundColor?: string;
  linkUrl?: string;
}

function buildUpdateTextStyleRequest(
  startIndex: number,
  endIndex: number,
  style: TextStyleArgs,
  tabId?: string,
): DocsRequest | null {
  const textStyle: Record<string, unknown> = {};
  const fields: string[] = [];

  if (style.bold !== undefined) {
    textStyle.bold = style.bold;
    fields.push('bold');
  }
  if (style.italic !== undefined) {
    textStyle.italic = style.italic;
    fields.push('italic');
  }
  if (style.strikethrough !== undefined) {
    textStyle.strikethrough = style.strikethrough;
    fields.push('strikethrough');
  }
  if (style.fontFamily !== undefined) {
    textStyle.weightedFontFamily = { fontFamily: style.fontFamily };
    fields.push('weightedFontFamily');
  }
  if (style.foregroundColor !== undefined) {
    const rgb = hexToRgbColor(style.foregroundColor);
    if (!rgb) return null;
    textStyle.foregroundColor = { color: { rgbColor: rgb } };
    fields.push('foregroundColor');
  }
  if (style.backgroundColor !== undefined) {
    const rgb = hexToRgbColor(style.backgroundColor);
    if (!rgb) return null;
    textStyle.backgroundColor = { color: { rgbColor: rgb } };
    fields.push('backgroundColor');
  }
  if (style.linkUrl !== undefined) {
    textStyle.link = { url: style.linkUrl };
    fields.push('link');
  }

  if (fields.length === 0) return null;

  const range: Record<string, unknown> = { startIndex, endIndex };
  if (tabId) range.tabId = tabId;

  return {
    updateTextStyle: {
      range,
      textStyle,
      fields: fields.join(','),
    },
  };
}

interface ParagraphStyleArgs {
  namedStyleType?: string;
}

function buildUpdateParagraphStyleRequest(
  startIndex: number,
  endIndex: number,
  style: ParagraphStyleArgs,
  tabId?: string,
): DocsRequest | null {
  const paragraphStyle: Record<string, unknown> = {};
  const fields: string[] = [];

  if (style.namedStyleType !== undefined) {
    paragraphStyle.namedStyleType = style.namedStyleType;
    fields.push('namedStyleType');
  }

  if (fields.length === 0) return null;

  const range: Record<string, unknown> = { startIndex, endIndex };
  if (tabId) range.tabId = tabId;

  return {
    updateParagraphStyle: {
      range,
      paragraphStyle,
      fields: fields.join(','),
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown-it setup
// ---------------------------------------------------------------------------

function createParser(): MarkdownIt {
  return new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    xhtmlOut: false,
  });
}

function getLinkHref(token: Token): string | null {
  if (token.type !== 'link_open') return null;
  const hrefAttr = token.attrs?.find(
    (attr: [string, string]) => attr[0] === 'href',
  );
  return hrefAttr ? hrefAttr[1] : null;
}

function getHeadingLevel(token: Token): number | null {
  if (!token.type.startsWith('heading_')) return null;
  const match = token.tag.match(/h(\d)/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Main conversion function
// ---------------------------------------------------------------------------

/**
 * Convert markdown to an array of Google Docs batchUpdate requests.
 * Returns insert requests followed by format requests.
 */
export function convertMarkdownToRequests(
  markdown: string,
  options?: ConvertOptions,
): DocsRequest[] {
  if (!markdown || markdown.trim().length === 0) {
    return [];
  }

  const startIndex = options?.startIndex ?? 1;
  const tabId = options?.tabId;

  const parser = createParser();
  const tokens = parser.parse(markdown, {});

  const context: ConversionContext = {
    currentIndex: startIndex,
    insertRequests: [],
    formatRequests: [],
    textRanges: [],
    formattingStack: [],
    listStack: [],
    paragraphRanges: [],
    normalParagraphRanges: [],
    listSpacingRanges: [],
    pendingListItems: [],
    openListItemStack: [],
    hrRanges: [],
    codeBlockRanges: [],
    tableState: undefined,
    inTableCell: false,
    tabId,
    titleConsumed: false,
    firstHeadingAsTitle: options?.firstHeadingAsTitle ?? false,
  };

  for (const token of tokens) {
    processToken(token, context);
  }

  finalizeFormatting(context);

  return [...context.insertRequests, ...context.formatRequests];
}

// ---------------------------------------------------------------------------
// Token processing
// ---------------------------------------------------------------------------

function processToken(token: Token, context: ConversionContext): void {
  switch (token.type) {
    // Headings
    case 'heading_open':
      handleHeadingOpen(token, context);
      break;
    case 'heading_close':
      handleHeadingClose(context);
      break;

    // Paragraphs
    case 'paragraph_open':
      handleParagraphOpen(context);
      break;
    case 'paragraph_close':
      handleParagraphClose(context);
      break;

    // Text content
    case 'text':
      handleTextToken(token, context);
      break;
    case 'code_inline':
      handleCodeInlineToken(token, context);
      break;

    // Inline formatting
    case 'strong_open':
      context.formattingStack.push({ bold: true });
      break;
    case 'strong_close':
      popFormatting(context, 'bold');
      break;
    case 'em_open':
      context.formattingStack.push({ italic: true });
      break;
    case 'em_close':
      popFormatting(context, 'italic');
      break;
    case 's_open':
      context.formattingStack.push({ strikethrough: true });
      break;
    case 's_close':
      popFormatting(context, 'strikethrough');
      break;

    // Links
    case 'link_open': {
      const href = getLinkHref(token);
      if (href) {
        context.formattingStack.push({ link: href });
      }
      break;
    }
    case 'link_close':
      popFormatting(context, 'link');
      break;

    // Lists
    case 'bullet_list_open':
      context.listStack.push({
        type: 'bullet',
        level: context.listStack.length,
      });
      break;
    case 'bullet_list_close':
      handleListClose(context);
      break;
    case 'ordered_list_open':
      context.listStack.push({
        type: 'ordered',
        level: context.listStack.length,
      });
      break;
    case 'ordered_list_close':
      handleListClose(context);
      break;
    case 'list_item_open':
      handleListItemOpen(context);
      break;
    case 'list_item_close':
      handleListItemClose(context);
      break;

    // Breaks
    case 'softbreak':
      if (context.inTableCell && context.tableState?.currentCell) {
        context.tableState.currentCell.text += ' ';
      } else {
        insertText(' ', context);
      }
      break;
    case 'hardbreak':
      if (context.inTableCell && context.tableState?.currentCell) {
        context.tableState.currentCell.text += '\n';
      } else {
        insertText('\n', context);
      }
      break;

    // Inline container
    case 'inline':
      if (token.children) {
        for (const child of token.children) {
          processToken(child, context);
        }
      }
      break;

    // Tables
    case 'table_open':
      context.tableState = {
        rows: [],
        currentRow: [],
        inHeader: false,
        currentCell: null,
      };
      break;
    case 'thead_open':
      if (context.tableState) context.tableState.inHeader = true;
      break;
    case 'thead_close':
      if (context.tableState) context.tableState.inHeader = false;
      break;
    case 'tbody_open':
    case 'tbody_close':
      break;
    case 'tr_open':
      if (context.tableState) context.tableState.currentRow = [];
      break;
    case 'tr_close':
      if (
        context.tableState &&
        context.tableState.currentRow.length > 0
      ) {
        context.tableState.rows.push([...context.tableState.currentRow]);
        context.tableState.currentRow = [];
      }
      break;
    case 'th_open':
    case 'td_open': {
      if (context.tableState) {
        context.tableState.currentCell = {
          text: '',
          isHeader:
            context.tableState.inHeader || token.type === 'th_open',
          textRanges: [],
        };
        context.inTableCell = true;
      }
      break;
    }
    case 'th_close':
    case 'td_close':
      if (context.tableState?.currentCell) {
        context.tableState.currentRow.push(context.tableState.currentCell);
        context.tableState.currentCell = null;
      }
      context.inTableCell = false;
      break;
    case 'table_close':
      if (context.tableState) {
        handleTableClose(context.tableState, context);
        context.tableState = undefined;
        context.inTableCell = false;
      }
      break;

    // Code blocks
    case 'fence':
    case 'code_block':
      handleCodeBlockToken(token, context);
      break;

    // Horizontal rules
    case 'hr':
      handleHorizontalRule(context);
      break;

    // Blockquotes (skip)
    case 'blockquote_open':
    case 'blockquote_close':
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Heading handlers
// ---------------------------------------------------------------------------

function handleHeadingOpen(token: Token, context: ConversionContext): void {
  const level = getHeadingLevel(token);
  if (level) {
    context.currentHeadingLevel = level;
    context.currentParagraphStart = context.currentIndex;
  }
}

function handleHeadingClose(context: ConversionContext): void {
  if (
    context.currentHeadingLevel &&
    context.currentParagraphStart !== undefined
  ) {
    const useTitle =
      context.firstHeadingAsTitle &&
      !context.titleConsumed &&
      context.currentHeadingLevel === 1;

    if (useTitle) {
      context.titleConsumed = true;
    }

    context.paragraphRanges.push({
      startIndex: context.currentParagraphStart,
      endIndex: context.currentIndex,
      namedStyleType: useTitle
        ? 'TITLE'
        : `HEADING_${context.currentHeadingLevel}`,
    });

    insertText('\n', context);
    context.currentHeadingLevel = undefined;
    context.currentParagraphStart = undefined;
  }
}

// ---------------------------------------------------------------------------
// Horizontal rule
// ---------------------------------------------------------------------------

function handleHorizontalRule(context: ConversionContext): void {
  if (!lastInsertEndsWithNewline(context)) {
    insertText('\n', context);
  }

  const start = context.currentIndex;
  insertText('\n', context);

  context.hrRanges.push({ startIndex: start, endIndex: context.currentIndex });
}

// ---------------------------------------------------------------------------
// Paragraph handlers
// ---------------------------------------------------------------------------

function handleParagraphOpen(context: ConversionContext): void {
  if (context.listStack.length === 0) {
    context.currentParagraphStart = context.currentIndex;
  }
}

function handleParagraphClose(context: ConversionContext): void {
  const paragraphStart = context.currentParagraphStart;

  if (!lastInsertEndsWithNewline(context)) {
    insertText('\n', context);
  }

  const currentListItem = getCurrentOpenListItem(context);
  if (currentListItem) {
    const paragraphEndIndex = lastInsertEndsWithNewline(context)
      ? context.currentIndex - 1
      : context.currentIndex;
    if (paragraphEndIndex > currentListItem.startIndex) {
      currentListItem.endIndex = paragraphEndIndex;
    }
  }

  if (paragraphStart !== undefined && context.listStack.length === 0) {
    context.normalParagraphRanges.push({
      startIndex: paragraphStart,
      endIndex: context.currentIndex,
    });
  }

  context.currentParagraphStart = undefined;
}

// ---------------------------------------------------------------------------
// List handlers
// ---------------------------------------------------------------------------

function handleListItemOpen(context: ConversionContext): void {
  if (context.listStack.length === 0) {
    throw new Error('List item found outside of list context');
  }

  const currentList = context.listStack[context.listStack.length - 1];
  const itemStart = context.currentIndex;

  if (currentList.level > 0) {
    insertText('\t'.repeat(currentList.level), context);
  }

  const listItem: PendingListItem = {
    startIndex: itemStart,
    nestingLevel: currentList.level,
    bulletPreset:
      currentList.type === 'ordered'
        ? 'NUMBERED_DECIMAL_ALPHA_ROMAN'
        : 'BULLET_DISC_CIRCLE_SQUARE',
    taskPrefixProcessed: false,
  };
  context.pendingListItems.push(listItem);
  context.openListItemStack.push(context.pendingListItems.length - 1);
}

function handleListItemClose(context: ConversionContext): void {
  const openIndex = context.openListItemStack.pop();
  if (openIndex === undefined) return;

  const listItem = context.pendingListItems[openIndex];
  if (listItem.endIndex === undefined) {
    const computedEndIndex = lastInsertEndsWithNewline(context)
      ? context.currentIndex - 1
      : context.currentIndex;
    if (computedEndIndex > listItem.startIndex) {
      listItem.endIndex = computedEndIndex;
    }
  }

  if (!lastInsertEndsWithNewline(context)) {
    insertText('\n', context);
  }
}

function handleListClose(context: ConversionContext): void {
  context.listStack.pop();

  if (context.listStack.length === 0) {
    for (let i = context.pendingListItems.length - 1; i >= 0; i--) {
      const item = context.pendingListItems[i];
      if (item.endIndex !== undefined && item.endIndex > item.startIndex) {
        context.listSpacingRanges.push({
          startIndex: item.startIndex,
          endIndex: item.endIndex,
        });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

function handleTextToken(token: Token, context: ConversionContext): void {
  let text = token.content;
  if (!text) return;

  // Inside a table cell — collect into cell buffer
  if (context.inTableCell && context.tableState?.currentCell) {
    const cell = context.tableState.currentCell;
    const startIndex = cell.text.length;
    cell.text += text;
    const formatting = mergeFormattingStack(context.formattingStack);
    if (hasFormatting(formatting)) {
      cell.textRanges.push({
        startIndex,
        endIndex: cell.text.length,
        formatting,
      });
    }
    return;
  }

  const currentListItem = getCurrentOpenListItem(context);
  if (currentListItem && !currentListItem.taskPrefixProcessed) {
    currentListItem.taskPrefixProcessed = true;
    const taskPrefixMatch = text.match(/^\[( |x|X)\]\s+/);
    if (taskPrefixMatch) {
      currentListItem.bulletPreset = 'BULLET_CHECKBOX';
      text = text.slice(taskPrefixMatch[0].length);
      if (!text) return;
    }
  }

  const startIndex = context.currentIndex;
  const endIndex = startIndex + text.length;

  insertText(text, context);

  const currentFormatting = mergeFormattingStack(context.formattingStack);
  if (hasFormatting(currentFormatting)) {
    context.textRanges.push({ startIndex, endIndex, formatting: currentFormatting });
  }
}

function handleCodeInlineToken(
  token: Token,
  context: ConversionContext,
): void {
  context.formattingStack.push({ code: true });
  handleTextToken(token, context);
  popFormatting(context, 'code');
}

// ---------------------------------------------------------------------------
// Code block handler
// ---------------------------------------------------------------------------

function handleCodeBlockToken(
  token: Token,
  context: ConversionContext,
): void {
  const normalizedContent = token.content.endsWith('\n')
    ? token.content.slice(0, -1)
    : token.content;
  const language = token.info?.trim() || undefined;

  // Ensure previous content ends with a newline before inserting the table
  if (
    context.insertRequests.length > 0 &&
    !lastInsertEndsWithNewline(context)
  ) {
    insertText('\n', context);
  }

  const tableStartIndex = context.currentIndex;

  // 1. Insert a 1x1 table
  const tableLocation: Record<string, unknown> = { index: tableStartIndex };
  if (context.tabId) tableLocation.tabId = context.tabId;
  context.insertRequests.push({
    insertTable: {
      location: tableLocation,
      rows: 1,
      columns: 1,
    },
  });

  // 2. Insert code text into the cell paragraph
  const cellContentIndex = tableStartIndex + CELL_CONTENT_OFFSET;
  const textLength = normalizedContent.length;

  if (textLength > 0) {
    const cellLocation: Record<string, unknown> = { index: cellContentIndex };
    if (context.tabId) cellLocation.tabId = context.tabId;
    context.insertRequests.push({
      insertText: {
        location: cellLocation,
        text: normalizedContent,
      },
    });
  }

  // 3. Track the code block for formatting in finalization
  context.codeBlockRanges.push({
    tableStartIndex,
    textStartIndex: cellContentIndex,
    textEndIndex: cellContentIndex + textLength,
    language,
  });

  // 4. Advance past the entire table structure
  context.currentIndex = tableStartIndex + EMPTY_1x1_TABLE_SIZE + textLength;

  // 5. Newline after table for paragraph separation
  insertText('\n', context);
}

// ---------------------------------------------------------------------------
// Table handler
// ---------------------------------------------------------------------------

function handleTableClose(
  tableState: TableState,
  context: ConversionContext,
): void {
  const rows = tableState.rows;
  if (rows.length === 0) return;

  const numRows = rows.length;
  const numCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (numCols === 0) return;

  // Ensure newline before table
  if (!lastInsertEndsWithNewline(context)) {
    insertText('\n', context);
  }

  const tableStartIndex = context.currentIndex;

  // Insert the table structure
  const tableLocation: Record<string, unknown> = { index: tableStartIndex };
  if (context.tabId) tableLocation.tabId = context.tabId;

  context.insertRequests.push({
    insertTable: {
      location: tableLocation,
      rows: numRows,
      columns: numCols,
    },
  });

  // Insert text into each cell, tracking cumulative offset
  let cumulativeTextLength = 0;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = rows[r]?.[c];
      if (!cell?.text) continue;

      const baseCellIndex =
        tableStartIndex + 4 + r * (1 + 2 * numCols) + 2 * c;
      const adjustedIndex = baseCellIndex + cumulativeTextLength;

      const cellLocation: Record<string, unknown> = { index: adjustedIndex };
      if (context.tabId) cellLocation.tabId = context.tabId;

      context.insertRequests.push({
        insertText: {
          location: cellLocation,
          text: cell.text,
        },
      });

      // Apply inline formatting from within the cell
      for (const range of cell.textRanges) {
        const absStart = adjustedIndex + range.startIndex;
        const absEnd = adjustedIndex + range.endIndex;

        if (
          range.formatting.bold ||
          range.formatting.italic ||
          range.formatting.strikethrough ||
          range.formatting.code
        ) {
          const styleReq = buildUpdateTextStyleRequest(
            absStart,
            absEnd,
            {
              bold: range.formatting.bold,
              italic: range.formatting.italic,
              strikethrough: range.formatting.strikethrough,
              fontFamily: range.formatting.code
                ? CODE_FONT_FAMILY
                : undefined,
              foregroundColor: range.formatting.code
                ? CODE_TEXT_HEX
                : undefined,
              backgroundColor: range.formatting.code
                ? CODE_BACKGROUND_HEX
                : undefined,
            },
            context.tabId,
          );
          if (styleReq) context.formatRequests.push(styleReq);
        }

        if (range.formatting.link) {
          const linkReq = buildUpdateTextStyleRequest(
            absStart,
            absEnd,
            { linkUrl: range.formatting.link },
            context.tabId,
          );
          if (linkReq) context.formatRequests.push(linkReq);
        }
      }

      // Bold all text in header cells
      if (cell.isHeader && cell.text.length > 0) {
        const headerStyleReq = buildUpdateTextStyleRequest(
          adjustedIndex,
          adjustedIndex + cell.text.length,
          { bold: true },
          context.tabId,
        );
        if (headerStyleReq) context.formatRequests.push(headerStyleReq);
      }

      cumulativeTextLength += cell.text.length;
    }
  }

  // Advance past the full table
  const emptyTableSize = 3 + numRows * (1 + 2 * numCols);
  context.currentIndex = tableStartIndex + emptyTableSize + cumulativeTextLength;

  // Newline after table
  insertText('\n', context);
}

// ---------------------------------------------------------------------------
// Insert helper
// ---------------------------------------------------------------------------

function insertText(text: string, context: ConversionContext): void {
  const location: Record<string, unknown> = { index: context.currentIndex };
  if (context.tabId) {
    location.tabId = context.tabId;
  }

  context.insertRequests.push({
    insertText: { location, text },
  });

  context.currentIndex += text.length;
}

// ---------------------------------------------------------------------------
// Formatting stack
// ---------------------------------------------------------------------------

function mergeFormattingStack(stack: FormattingState[]): FormattingState {
  const merged: FormattingState = {};
  for (const state of stack) {
    if (state.bold !== undefined) merged.bold = state.bold;
    if (state.italic !== undefined) merged.italic = state.italic;
    if (state.strikethrough !== undefined)
      merged.strikethrough = state.strikethrough;
    if (state.code !== undefined) merged.code = state.code;
    if (state.link !== undefined) merged.link = state.link;
  }
  return merged;
}

function hasFormatting(formatting: FormattingState): boolean {
  return (
    formatting.bold === true ||
    formatting.italic === true ||
    formatting.strikethrough === true ||
    formatting.code === true ||
    formatting.link !== undefined
  );
}

function popFormatting(
  context: ConversionContext,
  type: keyof FormattingState,
): void {
  for (let i = context.formattingStack.length - 1; i >= 0; i--) {
    if (context.formattingStack[i][type] !== undefined) {
      context.formattingStack.splice(i, 1);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Finalization — apply all deferred formatting requests
// ---------------------------------------------------------------------------

function finalizeFormatting(context: ConversionContext): void {
  // Character-level formatting (bold, italic, strikethrough, code, links)
  for (const range of context.textRanges) {
    if (
      range.formatting.bold ||
      range.formatting.italic ||
      range.formatting.strikethrough ||
      range.formatting.code
    ) {
      const styleRequest = buildUpdateTextStyleRequest(
        range.startIndex,
        range.endIndex,
        {
          bold: range.formatting.bold,
          italic: range.formatting.italic,
          strikethrough: range.formatting.strikethrough,
          fontFamily: range.formatting.code ? CODE_FONT_FAMILY : undefined,
          foregroundColor: range.formatting.code ? CODE_TEXT_HEX : undefined,
          backgroundColor: range.formatting.code
            ? CODE_BACKGROUND_HEX
            : undefined,
        },
        context.tabId,
      );
      if (styleRequest) {
        context.formatRequests.push(styleRequest);
      }
    }

    if (range.formatting.link) {
      const linkRequest = buildUpdateTextStyleRequest(
        range.startIndex,
        range.endIndex,
        { linkUrl: range.formatting.link },
        context.tabId,
      );
      if (linkRequest) {
        context.formatRequests.push(linkRequest);
      }
    }
  }

  // Paragraph-level formatting (headings)
  for (const paraRange of context.paragraphRanges) {
    if (paraRange.namedStyleType) {
      const paraRequest = buildUpdateParagraphStyleRequest(
        paraRange.startIndex,
        paraRange.endIndex,
        { namedStyleType: paraRange.namedStyleType },
        context.tabId,
      );
      if (paraRequest) {
        context.formatRequests.push(paraRequest);
      }
    }
  }

  // Normal paragraph spacing (8pt spaceBelow)
  for (const normalRange of context.normalParagraphRanges) {
    const range: Record<string, unknown> = {
      startIndex: normalRange.startIndex,
      endIndex: normalRange.endIndex,
    };
    if (context.tabId) range.tabId = context.tabId;

    context.formatRequests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: {
          spaceBelow: { magnitude: 8, unit: 'PT' },
        },
        fields: 'spaceBelow',
      },
    });
  }

  // List trailing spacing
  for (const listRange of context.listSpacingRanges) {
    const range: Record<string, unknown> = {
      startIndex: listRange.startIndex,
      endIndex: listRange.endIndex,
    };
    if (context.tabId) range.tabId = context.tabId;

    context.formatRequests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: {
          spaceBelow: { magnitude: 8, unit: 'PT' },
        },
        fields: 'spaceBelow',
      },
    });
  }

  // Code block table formatting
  for (const codeBlock of context.codeBlockRanges) {
    const tableStartLocation: Record<string, unknown> = {
      index: codeBlock.tableStartIndex + 1,
    };
    if (context.tabId) tableStartLocation.tabId = context.tabId;

    // Monospace text style inside cell
    if (codeBlock.textEndIndex > codeBlock.textStartIndex) {
      const codeTextStyle = buildUpdateTextStyleRequest(
        codeBlock.textStartIndex,
        codeBlock.textEndIndex,
        { fontFamily: CODE_FONT_FAMILY },
        context.tabId,
      );
      if (codeTextStyle) {
        context.formatRequests.push(codeTextStyle);
      }
    }

    // Cell background + border styling
    const borderStyle = {
      color: { color: { rgbColor: CODE_BLOCK_BORDER_RGB } },
      width: { magnitude: 0.5, unit: 'PT' },
      dashStyle: 'SOLID',
    };

    context.formatRequests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation,
            rowIndex: 0,
            columnIndex: 0,
          },
          rowSpan: 1,
          columnSpan: 1,
        },
        tableCellStyle: {
          backgroundColor: { color: { rgbColor: CODE_BLOCK_BG_RGB } },
          paddingTop: { magnitude: 8, unit: 'PT' },
          paddingBottom: { magnitude: 8, unit: 'PT' },
          paddingLeft: { magnitude: 12, unit: 'PT' },
          paddingRight: { magnitude: 12, unit: 'PT' },
          borderTop: borderStyle,
          borderBottom: borderStyle,
          borderLeft: borderStyle,
          borderRight: borderStyle,
        },
        fields:
          'backgroundColor,paddingTop,paddingBottom,paddingLeft,paddingRight,borderTop,borderBottom,borderLeft,borderRight',
      },
    });
  }

  // Horizontal rule styling (bottom border on empty paragraphs)
  for (const hrRange of context.hrRanges) {
    const range: Record<string, unknown> = {
      startIndex: hrRange.startIndex,
      endIndex: hrRange.endIndex,
    };
    if (context.tabId) range.tabId = context.tabId;

    context.formatRequests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: {
          borderBottom: {
            color: {
              color: {
                rgbColor: { red: 0.75, green: 0.75, blue: 0.75 },
              },
            },
            width: { magnitude: 1, unit: 'PT' },
            padding: { magnitude: 6, unit: 'PT' },
            dashStyle: 'SOLID',
          },
        },
        fields: 'borderBottom',
      },
    });
  }

  // List formatting — merge adjacent items of the same bullet type
  const validListItems = context.pendingListItems
    .filter(
      (item) => item.endIndex !== undefined && item.endIndex > item.startIndex,
    )
    .sort((a, b) => a.startIndex - b.startIndex);

  const mergedListRanges: {
    startIndex: number;
    endIndex: number;
    bulletPreset: string;
  }[] = [];
  for (const item of validListItems) {
    const last = mergedListRanges[mergedListRanges.length - 1];
    if (
      last &&
      last.bulletPreset === item.bulletPreset &&
      item.startIndex <= last.endIndex + 1
    ) {
      last.endIndex = Math.max(last.endIndex, item.endIndex!);
    } else {
      mergedListRanges.push({
        startIndex: item.startIndex,
        endIndex: item.endIndex!,
        bulletPreset: item.bulletPreset,
      });
    }
  }

  // Apply bottom-to-top to avoid index shifts from tab consumption
  mergedListRanges.sort((a, b) => b.startIndex - a.startIndex);

  for (const merged of mergedListRanges) {
    const rangeLocation: Record<string, unknown> = {
      startIndex: merged.startIndex,
      endIndex: merged.endIndex,
    };
    if (context.tabId) rangeLocation.tabId = context.tabId;

    context.formatRequests.push({
      createParagraphBullets: {
        range: rangeLocation,
        bulletPreset: merged.bulletPreset,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getCurrentOpenListItem(
  context: ConversionContext,
): PendingListItem | null {
  const openIndex =
    context.openListItemStack[context.openListItemStack.length - 1];
  if (openIndex === undefined) return null;
  return context.pendingListItems[openIndex] ?? null;
}

function lastInsertEndsWithNewline(context: ConversionContext): boolean {
  const last = context.insertRequests[context.insertRequests.length - 1];
  const text = (last?.insertText as { text?: string } | undefined)?.text;
  return Boolean(text && text.endsWith('\n'));
}
