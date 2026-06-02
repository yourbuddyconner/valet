import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
});

export function renderMarkdownToHtml(body: string): string {
  return markdown.render(body);
}
