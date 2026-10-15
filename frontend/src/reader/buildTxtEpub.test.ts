import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildTxtEpub, escapeHtml, textToHtml } from './buildTxtEpub';

describe('escapeHtml / textToHtml', () => {
  it('escapeHtml 转义特殊字符', () => {
    expect(escapeHtml('<a&"\'>')).toBe('&lt;a&amp;&quot;&#39;&gt;');
  });

  it('textToHtml 空行分段并转义', () => {
    expect(textToHtml('第一段\n\n第二段 <x>')).toBe('<p>第一段</p>\n<p>第二段 &lt;x&gt;</p>');
  });
});

describe('buildTxtEpub', () => {
  const chapters = [
    { id: 'ch-1', title: '第一章', text: '你好世界\n\n第二段' },
    { id: 'ch-2', title: '第二章', text: '另一章内容' },
  ];

  it('生成可解析的 EPUB zip（mimetype/container/opf/nav/章节齐全）', async () => {
    const buf = await buildTxtEpub(chapters);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    const zip = await JSZip.loadAsync(buf);
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
    expect(await zip.file('META-INF/container.xml')!.async('string')).toContain('content.opf');
    const opf = await zip.file('content.opf')!.async('string');
    // nav 声明（epub.js 经 manifest item properties="nav" 定位导航文件）
    expect(opf).toContain('properties="nav"');
    // 章节 href 约定：manifest / spine / nav 三处同形（epub.js spine.get 为字符串精确匹配）
    expect(opf).toContain('href="txt-0.xhtml"');
    expect(opf).toContain('idref="txt-1"');
    const nav = await zip.file('nav.xhtml')!.async('string');
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('href="txt-0.xhtml"');
    // 章节内容：标题在 h3、换行转段落
    const ch0 = await zip.file('txt-0.xhtml')!.async('string');
    expect(ch0).toContain('<h3>第一章</h3>');
    expect(ch0).toContain('<p>你好世界</p>');
    expect(ch0).toContain('<p>第二段</p>');
  });

  it('空正文章节被忽略，href 连号无空洞', async () => {
    const buf = await buildTxtEpub([
      { id: 'ch-a', title: '空白', text: '   ' },
      { id: 'ch-b', title: '正文', text: '有内容' },
    ]);
    const zip = await JSZip.loadAsync(buf);
    const opf = await zip.file('content.opf')!.async('string');
    expect(opf).not.toContain('txt-1.xhtml');
    expect(await zip.file('txt-0.xhtml')!.async('string')).toContain('有内容');
  });

  it('章节标题/正文经转义（含 XHTML 非法 XML 字符风险文本）', async () => {
    const buf = await buildTxtEpub([{ id: 'c', title: '第&章', text: '内容 <x> </x>' }]);
    const zip = await JSZip.loadAsync(buf);
    const html = await zip.file('txt-0.xhtml')!.async('string');
    expect(html).toContain('第&amp;章');
    expect(html).toContain('&lt;x&gt;');
  });

  it('mimetype 为 zip 首条目且不压缩（EPUB OCF 规范）', async () => {
    const buf = await buildTxtEpub(chapters);
    const bytes = new Uint8Array(buf);
    // zip 本地文件头：签名 PK\x03\x04；compression method 在偏移 8（小端 2 字节）；
    // 文件名长度在偏移 26（小端 2 字节），文件名自偏移 30 起
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    const method = bytes[8] | (bytes[9] << 8);
    const nameLen = bytes[26] | (bytes[27] << 8);
    const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLen));
    expect(name).toBe('mimetype');
    expect(method).toBe(0); // 0 = STORE 不压缩
  });
});
