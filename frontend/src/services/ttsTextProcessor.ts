/**
 * TTS 文本处理 — 纯函数模块
 *
 * 将长文本按句子边界分段，供 TTS 合成引擎逐段合成。
 * 包含 HTML 去标签和实体解码能力。
 */

// ===== 文本分段 =====

/**
 * 将长文本按句子边界分成适度长度的段落
 * 每段 < 200 字符，优先按句号 / 段落分
 */
export function splitText(text: string): string[] {
  const segments: string[] = [];

  // ⭐ 前置清理：移除可能导致 TTS 合成失败的 Unicode 特殊字符
  // 零宽字符（ZWSP/ZWNJ/ZWJ/BOM）、控制字符、装饰性私用区字符
  let cleaned = text
    .replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    // 保留常见装饰符号（◆◇■●※☆★○◎等），但移除纯符号段落首尾的孤立符号
    .replace(/(?:[◆◇■●※☆★○◎▷▶△▲▽▼□▣◈◐◑☯☰☱☲☳☴☵☶☷♠♣♥♦♤♧♡♢♔♕♖♗♘♙♚♛♜♝♞♟]+[\s　]*){3,}/g, '\n')
    .trim();

  // 按双换行分段（段落级）
  const paragraphs = cleaned.split(/\n\s*\n/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // 按句子分割
    const sentences = trimmed.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [trimmed];
    for (const sentence of sentences) {
      const st = sentence.trim();
      if (!st) continue;

      if (st.length > 200) {
        // 超长句子按逗号分割
        const subParts = st.match(/[^，、,；;：:]+[，、,；;：:]?/g) || [st];
        for (const part of subParts) {
          const pt = part.trim();
          // ⭐ 过滤纯符号/纯空白分段（TTS 合成这类空段会失败）
          if (pt && !/^[\s\u00A0◆◇■●※☆★○◎▷▶△▲▽▼□▣◈◐◑♠♣♥♦♤♧♡♢♔♕♖♗♘♙\u2000-\u206F\u2100-\u214F\u3000\u3001-\u303F]+$/.test(pt)) {
            segments.push(pt);
          }
        }
      } else {
        // ⭐ 过滤纯符号/纯空白分段
        if (!/^[\s\u00A0◆◇■●※☆★○◎▷▶△▲▽▼□▣◈◐◑♠♣♥♦♤♧♡♢♔♕♖♗♘♙\u2000-\u206F\u2100-\u214F\u3000\u3001-\u303F]+$/.test(st)) {
          segments.push(st);
        }
      }
    }
  }

  return segments.filter((s) => s.length > 0);
}

// ===== HTML 处理 =====

/**
 * 完整的 HTML 实体映射表（覆盖 EPUB 中常用实体）
 */
const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': '\u00A0',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&hellip;': '\u2026',
  '&lsquo;': '\u2018',
  '&rsquo;': '\u2019',
  '&sbquo;': '\u201A',
  '&ldquo;': '\u201C',
  '&rdquo;': '\u201D',
  '&bdquo;': '\u201E',
  '&laquo;': '\u00AB',
  '&raquo;': '\u00BB',
  '&copy;': '\u00A9',
  '&reg;': '\u00AE',
  '&trade;': '\u2122',
  '&bull;': '\u2022',
  '&middot;': '\u00B7',
  '&sect;': '\u00A7',
  '&para;': '\u00B6',
  '&deg;': '\u00B0',
  '&plusmn;': '\u00B1',
  '&times;': '\u00D7',
  '&divide;': '\u00F7',
  '&prime;': '\u2032',
  '&Prime;': '\u2033',
  '&euro;': '\u20AC',
  '&pound;': '\u00A3',
  '&yen;': '\u00A5',
  '&cent;': '\u00A2',
};

/**
 * 简易 HTML 去标签，提取纯文本
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    // 解码所有 HTML 实体（命名 + 数字）
    .replace(/&[a-zA-Z]+;/g, (match) => HTML_ENTITY_MAP[match] || match)
    .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 16)))
    // Remove leading whitespace from each line (artifact of HTML indentation)
    .replace(/^[ \t]+/gm, '')
    // Collapse multiple whitespace chars to single space
    .replace(/[\r\n]+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
