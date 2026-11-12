import { describe, it, expect, vi, afterEach } from 'vitest';

// 决定性复现：epubjs Book.open 完整流程 + mock XHR（ibooks display-options 404 vs 200 对照）
// 期望证明：display-options 404 → opened 永不 resolve → ReaderPage 20s 超时
// 注：iframe 内分页布局（epubjs contents.resizeCheck 的 rAF 循环）依赖真实布局管线，jsdom 不可达也无需可达——
// 渲染链的可测等价物是「spine 就绪且首项可加载」（load 会真正发起 nav.xhtml 请求）。

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:ireader:merged-test3</dc:identifier>
<dc:title>合辑测试书3</dc:title>
<dc:language>zh</dc:language>
</metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
<item id="idx" href="index.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="nav"/><itemref idref="idx"/></spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:ireader:merged-test3"/></head>
<docTitle><text>合辑测试书3</text></docTitle>
<navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>第一章</text></navLabel><content src="index.xhtml#sec_1"/></navPoint>
<navPoint id="n2" playOrder="2"><navLabel><text>第二章</text></navLabel><content src="index.xhtml#sec_2"/></navPoint>
</navMap>
</ncx>`;

const IBOOKS_OK = `<?xml version="1.0" encoding="UTF-8"?><display_options><platform name="*"><option name="fixed-layout">false</option></platform></display_options>`;

type UrlToResponse = Record<string, { status: number; body: string; contentType: string }>;

function mockXhr(map: UrlToResponse) {
  const original = globalThis.XMLHttpRequest;
  const calls: string[] = [];
  class FakeXHR {
    static DONE = 4;
    static HEADERS_RECEIVED = 2;
    status = 0;
    readyState = 0;
    response = '';
    responseText = '';
    responseXML: any = null;
    responseType: any = '';
    onload: any = null;
    onerror: any = null;
    onreadystatechange: any = null;
    headers: Record<string, string> = {};
    open(_m: string, url: string) { (this as any).__url = url; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    overrideMimeType(_m: string) {}
    send() {
      const url = String((this as any).__url || '');
      calls.push(url);
      const hit = Object.keys(map).find((k) => url.includes(k));
      const entry = hit ? map[hit] : { status: 404, body: 'not found', contentType: 'text/plain' };
      setTimeout(() => {
        this.readyState = 4;
        this.status = entry.status;
        this.responseText = entry.body;
        this.response = entry.body;
        if (entry.contentType.includes('xml') && entry.status === 200) {
          try { this.responseXML = new DOMParser().parseFromString(entry.body, entry.contentType as DOMParserSupportedType); } catch { /* ignore */ }
        }
        this.onload?.();
        this.onreadystatechange?.();
      }, 5);
    }
  }
  (globalThis as any).XMLHttpRequest = FakeXHR;
  return () => { (globalThis as any).XMLHttpRequest = original; console.warn('XHR CALLS:', JSON.stringify(calls)); };
}

async function openBook(ibooks: { status: number; body: string; contentType: string }, opts?: { withSpineDocs?: boolean }) {
  const xhtmlWrap = (body: string) => `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
  const restore = mockXhr({
    'container.xml': { status: 200, body: CONTAINER, contentType: 'application/xml' },
    'content.opf': { status: 200, body: OPF, contentType: 'application/oebps-package+xml' },
    'com.apple.ibooks': ibooks,
    'toc.ncx': { status: 200, body: NCX, contentType: 'application/x-dtbncx+xml' },
    ...(opts?.withSpineDocs ? {
      'nav.xhtml': { status: 200, body: xhtmlWrap('<p>导航页</p>'), contentType: 'application/xhtml+xml' },
      'index.xhtml': { status: 200, body: xhtmlWrap('<p>第一章内容</p><p>第二章内容</p><p>第三章内容</p>'), contentType: 'application/xhtml+xml' },
    } : {}),
  });
  try {
    const mod = await import('epubjs');
    const ePub = mod.default as any;
    const book = ePub('/api/books/fake/file/', {
      requestMethod: undefined,
      requestHeaders: { Authorization: 'Bearer fake' },
      replacements: 'none',
    } as any);
    const result = await Promise.race([
      (async () => {
        await (book as any).opened;
        if (opts?.withSpineDocs) {
          // 渲染链可测等价物：spine 就绪且首项可加载（load 真正发起 nav.xhtml 请求）
          const first = (book as any).spine?.spineItems?.[0];
          if (!first) return 'NO_SPINE';
          await first.load((book as any).load.bind(book as any));
          first.unload();
          return 'SPINE_READY:' + first.href;
        }
        return 'RESOLVED';
      })().catch((e: any) => 'REJECTED:' + (e?.status || e?.message || '?')),
      new Promise<string>((resolve) => setTimeout(() => resolve('HANG_3S'), 3000)),
    ]);
    // 不调 book.destroy()：jsdom 无 iframe/rAF 资源需回收，而 destroy 会清 this.loading，
    // 已在飞的 loadNavigation().then 回调随其落地时读 this.loading.navigation 会拖出 unhandled rejection
    return result;
  } finally {
    restore();
  }
}

describe('epubjs opened：display-options 404 vs 200 对照（合辑书加载超时根因）', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('opened resolve + spine 就绪且首项可加载（spine[0]=nav.xhtml 被 load 真实请求）', async () => {
    const r = await openBook({ status: 200, body: IBOOKS_OK, contentType: 'application/xml' }, { withSpineDocs: true });
    expect(r).toBe('SPINE_READY:nav.xhtml');
  });

  it('ibooks 200（合法 display_options）→ opened 应 resolve', async () => {
    const r = await openBook({ status: 200, body: IBOOKS_OK, contentType: 'application/xml' });
    expect(r).toBe('RESOLVED');
  });

  it('ibooks 404（服务端 AppError JSON）→ opened 行为（复现挂起）', async () => {
    const r = await openBook({ status: 404, body: JSON.stringify({ success: false, error: '文件不存在' }), contentType: 'application/json' });
    // 若为 HANG_3S → 实锤 404 卡死 opened；若 RESOLVED/REJECTED → 炸点另寻
    expect(['RESOLVED', 'REJECTED:404']).toContain(r);
    console.warn('ibooks404 result =', r);
  });
});
