/**
 * searchBook — 全书搜索（遍历 spine，逐章提取文本匹配）
 *
 * 实现要点：
 *  - 逐章 item.load 加载文档 → TreeWalker 遍历文本节点 → indexOf 匹配（大小写不敏感）
 *  - 命中时用 Range 包裹匹配文本，经 item.cfiFromRange 生成可跳转 CFI
 *  - 每章搜索后 item.unload() 释放，控制内存峰值；单章失败不中断全书搜索
 *  - limit 截断（默认 50），onProgress 回报进度
 */

export interface SearchResult {
  /** 命中位置 CFI（rendition.display 可跳转） */
  cfi: string;
  /** 上下文摘要（含命中词） */
  excerpt: string;
  /** 所属章节 href */
  chapterHref: string;
}

export interface SearchableSpineItem {
  href: string;
  load(request: unknown): Promise<Document>;
  cfiFromRange(range: Range): string;
  unload?(): void;
}

export interface SearchableBook {
  load(...args: unknown[]): unknown;
  spine: { spineItems: SearchableSpineItem[] };
}

export interface SearchOptions {
  /** 最大结果数（默认 50） */
  limit?: number;
  /** 上下文半径（摘要两侧字符数，默认 25） */
  contextRadius?: number;
  onProgress?: (done: number, total: number) => void;
}

/** NodeFilter.SHOW_TEXT 字面量（避免依赖全局 NodeFilter，测试/SSR 环境友好） */
const SHOW_TEXT = 4;

/** 提取命中位置的上下文摘要（压缩连续空白，越界侧加省略号） */
export function makeExcerpt(text: string, index: number, length: number, radius = 25): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

export async function searchBook(book: SearchableBook, query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = options.limit ?? 50;
  const radius = options.contextRadius ?? 25;
  const results: SearchResult[] = [];
  const items = book.spine?.spineItems ?? [];
  const request = typeof book.load === 'function' ? book.load.bind(book) : undefined;

  for (let i = 0; i < items.length && results.length < limit; i++) {
    const item = items[i];
    try {
      const doc = await item.load(request);
      const body = doc?.body;
      if (body) {
        const walker = doc.createTreeWalker(body, SHOW_TEXT);
        let node = walker.nextNode();
        while (node && results.length < limit) {
          const text = node.textContent ?? '';
          const lower = text.toLowerCase();
          let idx = lower.indexOf(q);
          while (idx !== -1 && results.length < limit) {
            const range = doc.createRange();
            range.setStart(node, idx);
            range.setEnd(node, Math.min(idx + q.length, text.length));
            results.push({
              cfi: item.cfiFromRange(range),
              excerpt: makeExcerpt(text, idx, q.length, radius),
              chapterHref: item.href,
            });
            idx = lower.indexOf(q, idx + q.length);
          }
          node = walker.nextNode();
        }
      }
    } catch {
      // 单章加载/解析失败不中断全书搜索
    } finally {
      try { item.unload?.(); } catch { /* 忽略释放失败 */ }
    }
    options.onProgress?.(i + 1, items.length);
  }
  return results;
}
