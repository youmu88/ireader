#!/usr/bin/env node
/**
 * 生成 iReader E2E 测试夹具文件
 * ==============================
 * 创建：
 *   1. 样例 TXT 文件（带章节标题）
 *   2. 样例 EPUB 文件（最小有效结构）
 *
 * 输出目录: ireader/backend/src/__fixtures__/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../backend/src/__fixtures__');

// ── TXT 文件 ──
function createSampleTxt() {
  const content = `三体：科学边界

第一章 科学边界

汪淼觉得，在这个宇宙中，没有什么事情是确定的。
他站在空旷的实验室里，看着屏幕上跳动的数据流。
"不可能，"他喃喃自语，"这完全违反了物理学定律。"

一个声音从他身后传来："违反的不是物理学，是我们对物理学的理解。"
汪淼转过身，看到一个穿着朴素的中年人站在门口。
"你是谁？"

"我叫申玉菲，是一名物理学家。"
申玉菲走到屏幕前，指着那串数据说：
"你看到的这个现象，我们称之为'宇宙闪烁'。"

第二章 射手与农场主

"有一个著名的假说，"申玉菲说，"叫做'射手与农场主'。"
汪淼皱起眉头："什么意思？"

"假设有一个神枪手，在一个靶子上每十厘米打一个洞。
靶子上生活着一种二维智能生物，
它们中的科学家经过观察发现：
宇宙中有一个伟大的定律——每隔十厘米，就会出现一个黑洞。
它们把这个定律奉为宇宙真理。"

申玉菲停顿了一下，继续说：
"直到有一天，神枪手决定在十五厘米处打一个洞。"

第三章 三体问题

汪淼坐在电脑前，开始运行三体问题的模拟程序。
屏幕上出现了三个质量相等的天体，
它们在引力作用下做着复杂的运动。

"三体问题，"他低声说，"三个天体的运动无法精确预测。
这不是因为计算能力不足，
而是因为系统本身是混沌的。"

他想起申玉菲的话：
"如果我们的太阳系处于一个三体系统中呢？
如果恒纪元只是短暂的和平，
而乱纪元才是常态——那我们的文明该如何延续？"

第四章 红岸基地

在遥远的中国东北，有一座隐蔽的基地——红岸。
叶文洁站在巨大的天线阵列前，
感受着从设备传来的微弱震动。

就是这个天线，在四年前向宇宙发出了第一声问候。
而现在，它收到了回复。
一个来自四光年外的回复。

"不要回答！不要回答！不要回答！"
信号用所有已知的语言重复着这句话。

叶文洁的手指悬在发送键上方，
她犹豫了很长时间，最终还是按了下去。

第五章 黑暗森林

罗辑从漫长的冬眠中醒来。
他被告知，自己现在是面壁者——人类最后的希望。

"宇宙是一座黑暗森林，"他说道，
"每个文明都是带枪的猎人，
像幽灵般潜行于林间，
轻轻拨开挡路的树枝，
竭力不让脚步发出一点声音。"

"为什么？"有人问。

"因为森林中到处都有与他一样潜行的猎人。
如果他发现了别的生命，
他没有任何选择——他必须开枪消灭对方。
这就是宇宙文明的图景，
这就是黑暗森林法则。"
`;

  const sampleDir = path.join(FIXTURES_DIR, 'samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const txtPath = path.join(sampleDir, 'three-body-sample.txt');
  fs.writeFileSync(txtPath, content, 'utf-8');
  console.log(`✅ 已创建样例 TXT: ${txtPath} (${content.length} 字节)`);
  return txtPath;
}

// ── EPUB 文件 ──
function createSampleEpub() {
  const sampleDir = path.join(FIXTURES_DIR, 'samples');
  fs.mkdirSync(sampleDir, { recursive: true });

  const epubDir = path.join('/tmp', `epub-builder-${Date.now()}`);
  fs.mkdirSync(epubDir, { recursive: true });

  // mimetype
  fs.writeFileSync(path.join(epubDir, 'mimetype'), 'application/epub+zip');

  // META-INF/container.xml
  const metaInfDir = path.join(epubDir, 'META-INF');
  fs.mkdirSync(metaInfDir, { recursive: true });
  fs.writeFileSync(path.join(metaInfDir, 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // OEBPS/
  const oebpsDir = path.join(epubDir, 'OEBPS');
  fs.mkdirSync(oebpsDir, { recursive: true });

  // Styles
  fs.writeFileSync(path.join(oebpsDir, 'style.css'), `body { font-family: serif; margin: 1em; }
h1 { text-align: center; font-size: 1.5em; }
p { text-indent: 2em; line-height: 1.6; }`);

  // Chapters
  const chapters = [
    { id: 'chapter1', title: '第一章 科学边界', content: '<p>汪淼觉得，在这个宇宙中，没有什么事情是确定的。</p><p>他站在空旷的实验室里，看着屏幕上跳动的数据流。</p><p>"不可能，"他喃喃自语，"这完全违反了物理学定律。"</p>' },
    { id: 'chapter2', title: '第二章 射手与农场主', content: '<p>"有一个著名的假说，"申玉菲说，"叫做\'射手与农场主\'。"</p><p>汪淼皱起眉头："什么意思？"</p>' },
    { id: 'chapter3', title: '第三章 三体问题', content: '<p>汪淼坐在电脑前，开始运行三体问题的模拟程序。</p><p>屏幕上出现了三个质量相等的天体，它们在引力作用下做着复杂的运动。</p>' },
  ];

  for (const ch of chapters) {
    fs.writeFileSync(path.join(oebpsDir, `${ch.id}.xhtml`), `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${ch.title}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${ch.title}</h1>
${ch.content}
</body>
</html>`);
  }

  // content.opf
  fs.writeFileSync(path.join(oebpsDir, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata>
    <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">三体：科学边界</dc:title>
    <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">刘慈欣</dc:creator>
    <dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">zh-CN</dc:language>
    <dc:identifier xmlns:dc="http://purl.org/dc/elements/1.1/" id="bookid">urn:uuid:sample-epub-001</dc:identifier>
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    ${chapters.map(ch => `<item id="${ch.id}" href="${ch.id}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${chapters.map(ch => `<itemref idref="${ch.id}"/>`).join('\n    ')}
  </spine>
</package>`);

  // toc.ncx
  fs.writeFileSync(path.join(oebpsDir, 'toc.ncx'), `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.dtd.org/NISO/2005/DTD/ncx-2005-1.dtd">
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <head>
    <meta name="dtb:uid" content="urn:uuid:sample-epub-001"/>
  </head>
  <docTitle><text>三体：科学边界</text></docTitle>
  <navMap>
    ${chapters.map((ch, i) => `<navPoint id="${ch.id}" playOrder="${i + 1}">
      <navLabel><text>${ch.title}</text></navLabel>
      <content src="${ch.id}.xhtml"/>
    </navPoint>`).join('\n    ')}
  </navMap>
</ncx>`);

  // 打包为 EPUB (ZIP)
  const epubPath = path.join(sampleDir, 'three-body-sample.epub');
  const cwd = process.cwd();
  process.chdir(epubDir);
  try {
    execSync('zip -qX0 ../book.epub mimetype', { cwd: epubDir });
    execSync('zip -qXr ../book.epub META-INF OEBPS', { cwd: epubDir });
    fs.copyFileSync(path.join(epubDir, '../book.epub'), epubPath);
  } finally {
    process.chdir(cwd);
  }

  // Cleanup temp dir
  fs.rmSync(epubDir, { recursive: true, force: true });
  if (fs.existsSync(path.join(epubDir, '../book.epub'))) {
    fs.unlinkSync(path.join(epubDir, '../book.epub'));
  }

  const stats = fs.statSync(epubPath);
  console.log(`✅ 已创建样例 EPUB: ${epubPath} (${stats.size} 字节)`);
  return epubPath;
}

// Main
fs.mkdirSync(FIXTURES_DIR, { recursive: true });
console.log('📦 生成 iReader 测试夹具文件...\n');
const txtPath = createSampleTxt();
const epubPath = createSampleEpub();
console.log(`\n🎉 夹具目录: ${FIXTURES_DIR}`);
console.log(`   TXT:  ${txtPath}`);
console.log(`   EPUB: ${epubPath}`);
