import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

export const MARKDOWN_RENDER_VERSION = 1;

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(source: string): string {
  const html = marked.parse(source.slice(0, 100_000), { async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'h3', 'hr', 'pre'],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      code: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer' }) },
  });
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().normalize('NFKD').replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 160);
  return slug || 'item';
}

export function excerpt(value: string, length = 180): string {
  return value.replace(/[#>*_`\[\]()!~-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}
