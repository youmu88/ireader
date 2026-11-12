import { describe, it, expect } from 'vitest';

// 复现：真实合辑 toc.ncx 被 epubjs Navigation 解析是否抛错（unpack 内 loadNavigation 无 catch → opened 挂起 → 前端 20s 超时）
const NCX = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:ireader:merged-test3"/></head>
<docTitle><text>合辑测试书3</text></docTitle>
<navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>第一章 测试章节1</text></navLabel><content src="index.xhtml#sec_1"/></navPoint>
<navPoint id="n2" playOrder="2"><navLabel><text>第二章 测试章节2</text></navLabel><content src="index.xhtml#sec_2"/></navPoint>
<navPoint id="n3" playOrder="3"><navLabel><text>第三章 测试章节3</text></navLabel><content src="index.xhtml#sec_3"/></navPoint>
</navMap>
</ncx>`;

describe('epubjs Navigation 解析合辑 toc.ncx', () => {
  it('Navigation 构造 + parse 不抛错且 toc 数正确', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ 'epubjs/lib/navigation.js');
    const Navigation = mod.default;
    expect(Navigation).toBeTruthy();
    const xml = new DOMParser().parseFromString(NCX, 'application/xml');
    const nav = new Navigation(xml);
    const parsed = await Promise.race([
      (nav as any).loaded ?? Promise.resolve(nav),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Navigation 解析挂起(2s)')), 2000)),
    ]);
    expect(parsed.toc.length).toBe(3);
  });
});
