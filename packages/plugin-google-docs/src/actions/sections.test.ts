import { describe, it, expect } from 'vitest';
import { extractSections, findSection, getBodyEndIndex, getBodyInsertIndex } from './sections.js';
import type { DocsBody } from './docs-to-markdown.js';

describe('extractSections', () => {
  it('returns empty array when body has no headings', () => {
    const body: DocsBody = {
      content: [
        {
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 12, textRun: { content: 'Hello world\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
    };
    expect(extractSections(body)).toEqual([]);
  });

  it('returns one section for a single heading', () => {
    const body: DocsBody = {
      content: [
        {
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 14, textRun: { content: 'Introduction\n' } },
            ],
            paragraphStyle: { namedStyleType: 'HEADING_1' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 14, endIndex: 30, textRun: { content: 'Some body text.\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
    };
    const sections = extractSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Introduction');
    expect(sections[0].level).toBe(1);
    expect(sections[0].startIndex).toBe(1);
    expect(sections[0].endIndex).toBe(30);
  });

  it('returns multiple sections with correct boundaries', () => {
    const body: DocsBody = {
      content: [
        {
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 10, textRun: { content: 'Chapter 1\n' } },
            ],
            paragraphStyle: { namedStyleType: 'HEADING_1' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 10, endIndex: 50, textRun: { content: 'Content for chapter 1 goes here...\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 50, endIndex: 62, textRun: { content: 'Subsection\n' } },
            ],
            paragraphStyle: { namedStyleType: 'HEADING_2' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 62, endIndex: 100, textRun: { content: 'Subsection content here...\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 100, endIndex: 112, textRun: { content: 'Chapter 2\n' } },
            ],
            paragraphStyle: { namedStyleType: 'HEADING_1' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 112, endIndex: 140, textRun: { content: 'Chapter 2 content here...\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
    };

    const sections = extractSections(body);
    expect(sections).toHaveLength(3);

    // Chapter 1 (H1) — ends at next H1 (Chapter 2)
    expect(sections[0].heading).toBe('Chapter 1');
    expect(sections[0].level).toBe(1);
    expect(sections[0].startIndex).toBe(1);
    expect(sections[0].endIndex).toBe(100);

    // Subsection (H2) — ends at next H1 (Chapter 2, which is same-or-higher)
    expect(sections[1].heading).toBe('Subsection');
    expect(sections[1].level).toBe(2);
    expect(sections[1].startIndex).toBe(50);
    expect(sections[1].endIndex).toBe(100);

    // Chapter 2 (H1) — ends at doc end
    expect(sections[2].heading).toBe('Chapter 2');
    expect(sections[2].level).toBe(1);
    expect(sections[2].startIndex).toBe(100);
    expect(sections[2].endIndex).toBe(140);
  });
});

describe('findSection', () => {
  const body: DocsBody = {
    content: [
      {
        paragraph: {
          elements: [
            { startIndex: 1, endIndex: 14, textRun: { content: 'Introduction\n' } },
          ],
          paragraphStyle: { namedStyleType: 'HEADING_1' },
        },
      },
      {
        paragraph: {
          elements: [
            { startIndex: 14, endIndex: 40, textRun: { content: 'Some content here...\n' } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
      {
        paragraph: {
          elements: [
            { startIndex: 40, endIndex: 65, textRun: { content: 'Getting Started Guide\n' } },
          ],
          paragraphStyle: { namedStyleType: 'HEADING_2' },
        },
      },
      {
        paragraph: {
          elements: [
            { startIndex: 65, endIndex: 100, textRun: { content: 'Guide content goes here...\n' } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ],
  };

  it('finds section by exact heading text', () => {
    const section = findSection(body, 'Introduction');
    expect(section).not.toBeNull();
    expect(section!.heading).toBe('Introduction');
  });

  it('finds section case-insensitively', () => {
    const section = findSection(body, 'introduction');
    expect(section).not.toBeNull();
    expect(section!.heading).toBe('Introduction');
  });

  it('finds section by substring match', () => {
    const section = findSection(body, 'Started');
    expect(section).not.toBeNull();
    expect(section!.heading).toBe('Getting Started Guide');
  });

  it('returns null for nonexistent heading', () => {
    const section = findSection(body, 'Nonexistent Section');
    expect(section).toBeNull();
  });
});

describe('getBodyEndIndex', () => {
  it('returns 1 for empty body', () => {
    const body: DocsBody = { content: [] };
    expect(getBodyEndIndex(body)).toBe(1);
  });

  it('returns 1 for undefined content', () => {
    const body: DocsBody = {};
    expect(getBodyEndIndex(body)).toBe(1);
  });

  it('returns last element endIndex for body with paragraphs', () => {
    const body: DocsBody = {
      content: [
        {
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 20, textRun: { content: 'First paragraph.\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 20, endIndex: 45, textRun: { content: 'Second paragraph.\n' } },
            ],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          },
        },
      ],
    };
    expect(getBodyEndIndex(body)).toBe(45);
  });
});

describe('getBodyInsertIndex', () => {
  it('returns 1 for an empty document body', () => {
    const body: DocsBody = {
      content: [
        {
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 2, textRun: { content: '\n' } },
            ],
          },
        },
      ],
    };

    expect(getBodyInsertIndex(body)).toBe(1);
  });

  it('returns the last writable position before the trailing newline', () => {
    const body: DocsBody = {
      content: [
        {
          paragraph: {
            elements: [
              { startIndex: 1, endIndex: 20, textRun: { content: 'First paragraph.\n' } },
            ],
          },
        },
        {
          paragraph: {
            elements: [
              { startIndex: 20, endIndex: 45, textRun: { content: 'Second paragraph.\n' } },
            ],
          },
        },
      ],
    };

    expect(getBodyInsertIndex(body)).toBe(44);
  });
});
