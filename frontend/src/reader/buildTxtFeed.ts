/**
 * buildTxtFeed — 将 TXT 章节文本组装为 epub.js HTML Feed
 *
 * epub.js 支持以「章节列表」HTML Feed 方式渲染（Epub([...sections])），
 * 每个 TXT 章节映射为一个 <section>，从而复用既有渲染管线
 * （theme/fontSize/progress/翻页/滚动/书签/搜索全部通吃）。
 *
 * 输出一个 { sections, spine } 结构：
 *  - sections: [{ id, href, html }]，html 为转义后的章节正文
 *  - spine: sections 的 href 顺序表
 */

export interface TxtFeedSection {
  id: string;
  href: string;
  /** 章节完整 XHTML（含 <section> 骨架与转义正文） */
  html: string;
}

export interface TxtFeed {
  sections: TxtFeedSection[];
  spine: string[];
}

/** 将纯文本转为 HTML 段落（
 分段，HTML 转义防注入） */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(block => `<p>${escapeHtml(block.trim())}</p>`)
    .join('\n');
}

/** HTML 特殊字符转义 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TxtChapterInput {
  id: string;
  title: string;
  /** 章节纯文本正文 */
  text: string;
}

/** 组装 TXT HTML Feed（sections + spine）。空正文忽略。 */
export function buildTxtFeed(chapters: TxtChapterInput[]): TxtFeed {
  const sections: TxtFeedSection[] = [];
  let idx = 0;
  for (const ch of chapters) {
    if (!ch.text.trim()) continue;
    const href = `txt-${idx}.xhtml`;
    const html = `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n`
      + `<title>${escapeHtml(ch.title || '')}</title>\n</head>\n<body>\n`
      + `<h3>${escapeHtml(ch.title || '')}</h3>\n`
      + textToHtml(ch.text)
      + `\n</body>\n</html>`;
    sections.push({ id: ch.id, href, html });
    idx++;
  }
  return { sections, spine: sections.map(s => s.href) };
}
