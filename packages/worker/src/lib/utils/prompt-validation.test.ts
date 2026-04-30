import { describe, it, expect } from 'vitest';
import {
  sanitizePromptAttachments,
  attachmentPartsForMessage,
} from './prompt-validation.js';

function fakeAttachment(mime: string, filename?: string) {
  return {
    type: 'file',
    mime,
    url: `data:${mime};base64,aGVsbG8=`,
    ...(filename ? { filename } : {}),
  };
}

// ─── sanitizePromptAttachments ─────────────────────────────────────────────

describe('sanitizePromptAttachments', () => {
  describe('text/* MIME types are accepted', () => {
    it.each([
      'text/plain',
      'text/csv',
      'text/markdown',
      'text/html',
    ])('accepts %s', (mime) => {
      const { attachments, rejectedTypes } = sanitizePromptAttachments([fakeAttachment(mime)]);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].mime).toBe(mime);
      expect(rejectedTypes).toHaveLength(0);
    });
  });

  describe('application/* text format types are accepted', () => {
    it.each([
      'application/json',
      'application/xml',
      'application/x-yaml',
      'application/toml',
      'application/sql',
      'application/graphql',
    ])('accepts %s', (mime) => {
      const { attachments, rejectedTypes } = sanitizePromptAttachments([fakeAttachment(mime)]);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].mime).toBe(mime);
      expect(rejectedTypes).toHaveLength(0);
    });
  });

  describe('application/octet-stream with known text file extensions', () => {
    it.each([
      ['main.py', 'text/x-python'],
      ['index.ts', 'text/x-typescript'],
      ['config.yaml', 'application/x-yaml'],
    ])('resolves %s to %s', (filename, expectedMime) => {
      const { attachments, rejectedTypes } = sanitizePromptAttachments([
        fakeAttachment('application/octet-stream', filename),
      ]);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].mime).toBe(expectedMime);
      expect(rejectedTypes).toHaveLength(0);
    });
  });

  describe('application/octet-stream with unknown extensions is rejected', () => {
    it.each([
      'binary.wasm',
      'archive.zip',
    ])('rejects %s', (filename) => {
      const { attachments, rejectedTypes } = sanitizePromptAttachments([
        fakeAttachment('application/octet-stream', filename),
      ]);
      expect(attachments).toHaveLength(0);
      expect(rejectedTypes).toHaveLength(1);
    });
  });

  it('rejects application/octet-stream with no filename', () => {
    const { attachments, rejectedTypes } = sanitizePromptAttachments([
      fakeAttachment('application/octet-stream'),
    ]);
    expect(attachments).toHaveLength(0);
    expect(rejectedTypes).toHaveLength(1);
  });

  it('resolves empty MIME with known extension to correct MIME', () => {
    const { attachments, rejectedTypes } = sanitizePromptAttachments([
      fakeAttachment('', 'README.md'),
    ]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mime).toBe('text/markdown');
    expect(rejectedTypes).toHaveLength(0);
  });

  describe('existing types still work', () => {
    it('accepts images', () => {
      const { attachments } = sanitizePromptAttachments([fakeAttachment('image/png', 'photo.png')]);
      expect(attachments).toHaveLength(1);
    });

    it('accepts audio', () => {
      const { attachments } = sanitizePromptAttachments([fakeAttachment('audio/mpeg', 'song.mp3')]);
      expect(attachments).toHaveLength(1);
    });

    it('accepts PDFs', () => {
      const { attachments } = sanitizePromptAttachments([
        fakeAttachment('application/pdf', 'doc.pdf'),
      ]);
      expect(attachments).toHaveLength(1);
    });
  });
});

// ─── attachmentPartsForMessage ─────────────────────────────────────────────

describe('attachmentPartsForMessage', () => {
  it('produces file parts for text MIME attachments', () => {
    const attachments = [
      { type: 'file' as const, mime: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=', filename: 'readme.txt' },
      { type: 'file' as const, mime: 'application/json', url: 'data:application/json;base64,e30=', filename: 'data.json' },
    ];
    const parts = attachmentPartsForMessage(attachments);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: 'file',
      mimeType: 'text/plain',
      filename: 'readme.txt',
    });
    expect(parts[1]).toMatchObject({
      type: 'file',
      mimeType: 'application/json',
      filename: 'data.json',
    });
  });

  it('still produces image parts for image MIME types', () => {
    const attachments = [
      { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=', filename: 'photo.png' },
    ];
    const parts = attachmentPartsForMessage(attachments);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image');
  });
});
