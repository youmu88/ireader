/**
 * buildTxtEpub — 将 TXT 章节文本组装为内存 EPUB（ArrayBuffer），供 epub.js 渲染。
 *
 * 背景（2026-10-15 实测修复）：TXT 早期方案假设「epub.js 支持裸数组 HTML Feed 书源」不成立——
 * epub.js@0.3.93 的 Book 构造中，非 string/Blob/ArrayBuffer 的入参会被当作 options 吞掉
 * （见 epubjs/src/book.js constructor），url 变 undefined 后 book.ready 永不 resolve，
 * 表现为 TXT 阅读器 20s 超时（在线/离线皆然；旧单测 mock 了 epubjs，从未暴露该问题）。
 * 改用官方支持的内存书源：以内联 EPUB3 zip（BINARY 输入）承载章节。
 *
 * zip 结构（最小合法 EPUB3，根布局——与自托管书库 extracted 目录同构，
 * 离线包（epubArchives）zip 已验证该布局在 archived 模式下可用）：
 *   mimetype                     （STORE 不压缩）
 *   META-INF/container.xml       → content.opf
 *   content.opf                  （manifest：nav + 各章；spine 顺序）
 *   nav.xhtml                    （EPUB3 nav toc；epub.js 经 <item properties="nav"> 定位解析）
 *   txt-{i}.xhtml                （章节 XHTML）
 *
 * 注：不用 OEBPS/ 子目录——epub.js Book.path 取 OPF 所在目录后，openPackaging 再次
 * resolve('OEBPS/content.opf') 会产生 'OEBPS/OEBPS/content.opf' 双前缀而取不到条目；
 * 根布局下 path.resolve('/', 'content.opf')='/content.opf'，archive 去掉前导 '/' 后正确命中。
 *
 * href 约定：manifest/nav 中的章节 href 均为不带目录前缀的 `txt-{i}.xhtml`。
 * epub.js 的 section.href 取 OPF manifest href 原样（不 resolve，见 spine.js unpack），
 * spine.get(href) 为字符串精确匹配，故 nav 与 manifest 必须同形；
 * 该命名同时与 ttsScheduler 章节推进表（displayHref）约定一致。
 */
import JSZip from 'jszip';

export interface TxtChapterInput {
  id: string;
  title: string;
  /** 章节纯文本正文 */
  text: string;
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

/** 将纯文本转为 HTML 段落（空行分段，HTML 转义防注入） */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(block => `<p>${escapeHtml(block.trim())}</p>`)
    .join('\n');
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function chapterXhtml(ch: TxtChapterInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title>${escapeHtml(ch.title || '')}</title>
</head>
<body>
<h3>${escapeHtml(ch.title || '')}</h3>
${textToHtml(ch.text)}
</body>
</html>`;
}

function navXhtml(sections: TxtChapterInput[]): string {
  const items = sections
    .map((ch, i) => `      <li><a href="txt-${i}.xhtml">${escapeHtml(ch.title || `第${i + 1}部分`)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<title>目录</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function opfXml(sectionCount: number): string {
  const manifest = Array.from({ length: sectionCount }, (_, i) =>
    `    <item id="txt-${i}" href="txt-${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
  const spine = Array.from({ length: sectionCount }, (_, i) => `    <itemref idref="txt-${i}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="ireader-txt-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="ireader-txt-id">urn:ireader:txt</dc:identifier>
    <dc:title>iReader TXT</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`;
}

/** 组装内存 EPUB（ArrayBuffer）。空正文章节忽略；章节 href 连号（txt-0.xhtml 起）。 */
export async function buildTxtEpub(chapters: TxtChapterInput[]): Promise<ArrayBuffer> {
  const sections = chapters.filter((ch) => ch.text.trim());
  const zip = new JSZip();
  // mimetype 须为 zip 内第一个条目且不压缩（EPUB OCF 规范；JSZip 按添加顺序写入）
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);
  for (let i = 0; i < sections.length; i++) {
    zip.file(`txt-${i}.xhtml`, chapterXhtml(sections[i]));
  }
  zip.file('nav.xhtml', navXhtml(sections));
  zip.file('content.opf', opfXml(sections.length));
  return zip.generateAsync({ type: 'arraybuffer' });
}
