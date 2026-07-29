/**
 * stripHtml — 将 HTML 转为纯文本（保留段落结构）
 * 从 ReaderPage 提取的公共工具函数。
 */
export function stripHtml(html: string): string {
  let s = html;
  // Convert block-level closing tags to newlines (preserves paragraph structure)
  s = s.replace(/<\/(?:p|div|h[1-6]|blockquote|li|tr|th|td)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<(?:p|div|h[1-6]|blockquote|li|tr|th|td)[^>]*>/gi, '\n');
  // Remove head/script/style blocks
  s = s.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove SVG / figure / noscript / iframe / canvas / object blocks
  s = s.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '');
  s = s.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
  s = s.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/gi, '');
  s = s.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '');
  // Remove all remaining HTML tags
  s = s.replace(/<[^>]*>/g, '').replace(/<[\s\S]*?>/g, '');
  // Decode HTML entities
  s = s.replace(/&nbsp;/g, '\u00A0')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&apos;/g, "'")
       .replace(/&mdash;/g, '\u2014')
       .replace(/&ndash;/g, '\u2013')
       .replace(/&hellip;/g, '\u2026')
       .replace(/&lsquo;/g, '\u2018')
       .replace(/&rsquo;/g, '\u2019')
       .replace(/&ldquo;/g, '\u201C')
       .replace(/&rdquo;/g, '\u201D')
       .replace(/&laquo;/g, '\u00AB')
       .replace(/&raquo;/g, '\u00BB')
       .replace(/&copy;/g, '\u00A9')
       .replace(/&reg;/g, '\u00AE')
       .replace(/&trade;/g, '\u2122')
       .replace(/&bull;/g, '\u2022')
       .replace(/&middot;/g, '\u00B7')
       .replace(/&euro;/g, '\u20AC')
       .replace(/&pound;/g, '\u00A3')
       .replace(/&yen;/g, '\u00A5')
       .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 10)))
       .replace(/&#x([0-9a-fA-F]+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 16)));
  // Normalize whitespace
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/^[ \t]+/gm, '');
  s = s.replace(/^[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
