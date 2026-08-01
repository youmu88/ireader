import { describe, expect, it } from 'vitest';
import { buildTxtFeed, escapeHtml, textToHtml } from './buildTxtFeed';

describe('escapeHtml / textToHtml', () => {
  it('escapeHtml 转义特殊字符', () => {
    expect(escapeHtml(`<b>&"'"</b>`)).toBe('&lt;b&gt;&amp;&quot;&#39;&quot;&lt;/b&gt;');
  });

  it('textToHtml 按空行分组为段落并 trim', () => {
    const html = textToHtml('第一段\n\n  第二段\n第三段');
    expect(html).toContain('<p>第一段</p>');
    expect(html).toContain('<p>第二段\n第三段</p>');
  });

  it('textToHtml 转义正文，防 HTML 注入', () => {
    const html = textToHtml('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('buildTxtFeed', () => {
  it('每个非空章节生成一个 section，标题出现在 h3', () => {
    const feed = buildTxtFeed([
      { id: 'ch-1', title: '第一章', text: '你好世界\n\n第二段' },
      { id: 'ch-2', title: '第二章', text: '另一章内容' },
    ]);
    expect(feed.sections).toHaveLength(2);
    expect(feed.sections[0].href).toBe('txt-0.xhtml');
    expect(feed.sections[1].href).toBe('txt-1.xhtml');
    expect(feed.spine).toEqual(['txt-0.xhtml', 'txt-1.xhtml']);
    expect(feed.sections[0].html).toContain('<h3>第一章</h3>');
    expect(feed.sections[0].html).toContain('<p>你好世界</p>');
  });

  it('空正文章节被忽略，href 连续无空洞', () => {
    const feed = buildTxtFeed([
      { id: 'ch-a', title: '空白', text: '   ' },
      { id: 'ch-b', title: '正文', text: '有内容' },
    ]);
    expect(feed.sections).toHaveLength(1);
    expect(feed.sections[0].href).toBe('txt-0.xhtml');
  });

  it('章节标题/正文经转义（含 XHTML 非法 XML 字符风险文本）', () => {
    const feed = buildTxtFeed([{ id: 'c', title: '第&章', text: '内容 <x> </x>' }]);
    const html = feed.sections[0].html;
    expect(html).toContain('第&amp;章');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });

  it('无有效章节时返回空 feed', () => {
    const feed = buildTxtFeed([]);
    expect(feed.sections).toHaveLength(0);
    expect(feed.spine).toEqual([]);
  });
});