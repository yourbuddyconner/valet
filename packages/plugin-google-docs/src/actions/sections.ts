// sections.ts — Section resolution helpers for Google Docs

import type { DocsBody, StructuralElement, Table } from './docs-to-markdown.js';

export interface Section {
  heading: string;
  level: number; // 1-6
  startIndex: number; // start of heading paragraph
  endIndex: number; // start of next same-or-higher-level heading, or doc end
}

/**
 * Determine the heading level from a paragraph's namedStyleType.
 * Returns null if the paragraph is not a heading.
 */
function headingLevel(namedStyleType: string | undefined): number | null {
  if (!namedStyleType) return null;
  if (namedStyleType === 'TITLE') return 1;
  if (namedStyleType === 'SUBTITLE') return 2;
  const match = namedStyleType.match(/^HEADING_(\d)$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract the plain text from a paragraph's elements (joined text runs, trailing newline trimmed).
 */
function paragraphText(elements: { textRun?: { content?: string } }[] | undefined): string {
  if (!elements) return '';
  let text = '';
  for (const el of elements) {
    if (el.textRun?.content) {
      text += el.textRun.content;
    }
  }
  // Trim trailing newline (Google Docs paragraphs always end with \n)
  return text.replace(/\n$/, '');
}

/**
 * Get the startIndex from a structural element.
 * For paragraphs, uses the first paragraph element's startIndex.
 * For tables, walks into the first row/cell/content.
 */
function elementStartIndex(element: StructuralElement): number | undefined {
  if (element.paragraph?.elements) {
    for (const pe of element.paragraph.elements) {
      if (pe.startIndex !== undefined) return pe.startIndex;
    }
  }
  if (element.table?.tableRows) {
    for (const row of element.table.tableRows) {
      if (!row.tableCells) continue;
      for (const cell of row.tableCells) {
        if (!cell.content) continue;
        for (const se of cell.content) {
          const idx = elementStartIndex(se);
          if (idx !== undefined) return idx;
        }
      }
    }
  }
  return undefined;
}

/**
 * Get the deepest endIndex from a structural element.
 */
function elementEndIndex(element: StructuralElement): number | undefined {
  if (element.paragraph?.elements) {
    const els = element.paragraph.elements;
    for (let i = els.length - 1; i >= 0; i--) {
      if (els[i].endIndex !== undefined) return els[i].endIndex;
    }
  }
  if (element.table) {
    return tableEndIndex(element.table);
  }
  return undefined;
}

/**
 * Walk a table to find the deepest endIndex.
 */
function tableEndIndex(table: Table): number | undefined {
  const rows = table.tableRows;
  if (!rows) return undefined;
  for (let r = rows.length - 1; r >= 0; r--) {
    const cells = rows[r].tableCells;
    if (!cells) continue;
    for (let c = cells.length - 1; c >= 0; c--) {
      const content = cells[c].content;
      if (!content) continue;
      for (let e = content.length - 1; e >= 0; e--) {
        const idx = elementEndIndex(content[e]);
        if (idx !== undefined) return idx;
      }
    }
  }
  return undefined;
}

/** Extract all sections from a document body. */
export function extractSections(body: DocsBody): Section[] {
  const content = body.content;
  if (!content || content.length === 0) return [];

  const docEnd = getBodyEndIndex(body);
  const sections: Section[] = [];

  for (const element of content) {
    if (!element.paragraph) continue;
    const level = headingLevel(element.paragraph.paragraphStyle?.namedStyleType);
    if (level === null) continue;

    const heading = paragraphText(element.paragraph.elements);
    const startIndex = elementStartIndex(element);
    if (startIndex === undefined) continue;

    sections.push({
      heading,
      level,
      startIndex,
      endIndex: docEnd, // placeholder, will be refined below
    });
  }

  // Compute endIndex: each section ends where the next heading of equal or higher level starts
  for (let i = 0; i < sections.length; i++) {
    const current = sections[i];
    // Look for next heading at same or higher level (lower or equal number)
    let endIndex = docEnd;
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= current.level) {
        endIndex = sections[j].startIndex;
        break;
      }
    }
    current.endIndex = endIndex;
  }

  return sections;
}

/** Find a section by heading text (case-insensitive substring match). */
export function findSection(body: DocsBody, headingText: string): Section | null {
  const sections = extractSections(body);
  const needle = headingText.toLowerCase();
  return sections.find((s) => s.heading.toLowerCase().includes(needle)) ?? null;
}

/** Get the end index of the document body (last element's endIndex). */
export function getBodyEndIndex(body: DocsBody): number {
  const content = body.content;
  if (!content || content.length === 0) return 1;

  for (let i = content.length - 1; i >= 0; i--) {
    const idx = elementEndIndex(content[i]);
    if (idx !== undefined) return idx;
  }

  return 1;
}

/** Get the last writable insertion index in the document body. */
export function getBodyInsertIndex(body: DocsBody): number {
  return Math.max(1, getBodyEndIndex(body) - 1);
}
