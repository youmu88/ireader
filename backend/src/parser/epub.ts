import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import yauzl from 'yauzl';
import EPub from 'epub';

const TEXT_ENCODING = 'utf-8';

export interface EpubMeta {
  title: string;
  author: string | null;
  coverPath: string | null;
}

export interface EpubChapter {
  id: string;
  title: string;
  href: string;
  order: number;
  level: number;
}

export interface EpubParseResult {
  meta: EpubMeta;
  chapters: EpubChapter[];
  extractedDir: string;
}

/**
 * Build a map from resolved href → TOC title using the epub library's toc tree.
 */
function buildTocTitleMap(tocItems: any[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(items: any[]) {
    for (const item of items) {
      if (item.href && item.title) {
        // epub library's item.href is already relative to EPUB root
        const resolved = item.href.startsWith('/') ? item.href.slice(1) : item.href;
        // Only store the first (most specific) TOC entry for each href
        if (!map.has(resolved)) {
          map.set(resolved, item.title);
        }
      }
      if (item.subitems?.length) {
        walk(item.subitems);
      }
    }
  }
  walk(tocItems);
  return map;
}

/**
 * Extract individual chapters from EPUB TOC (navMap) for "single-file" EPUBs
 * where all content is in one XHTML file referenced via anchors (#toc_X).
 *
 * These EPUBs have a flat spine (few items) but rich TOC hierarchy.
 * Typical examples: book collections/compilations merged into one file.
 */
function extractTocChapters(tocItems: any[], baseOrder: number, seenHrefs: Set<string>): EpubChapter[] {
  const chapters: EpubChapter[] = [];
  let order = baseOrder;

  function walk(items: any[], depth: number) {
    for (const item of items) {
      if (item.href && item.title) {
        const resolved = item.href.startsWith('/') ? item.href.slice(1) : item.href;
        const hasAnchor = resolved.includes('#');
        const isLeaf = !item.subitems?.length;

        // Only include items with anchors (anchored chapters within a single file)
        // or leaf items deeper than root level
        if (hasAnchor || (isLeaf && depth > 0)) {
          // Skip if already seen via flow/spine
          if (seenHrefs.has(resolved)) continue;
          seenHrefs.add(resolved);

          order++;
          chapters.push({
            id: `ch-toc-${order}`,
            title: item.title,
            href: resolved,
            order,
            level: Math.min(depth + 1, 9),
          });
        }
      }
      if (item.subitems?.length) {
        walk(item.subitems, depth + 1);
      }
    }
  }

  walk(tocItems, 0);
  return chapters;
}

/**
 * 使用内联 Python 代码修复被"二次包装"的 EPUB 文件（内容嵌套在子目录中）。
 * 通过 python3 -c 传递脚本，不依赖外部文件。
 * 修复逻辑：检测 ZIP 中所有文件是否在同一顶层目录下（如 `书名.epub/mimetype`），
 * 去掉该目录前缀后重新打包为符合 EPUB 标准的文件。
 */
function rebuildEpubWithPython(sourcePath: string, tmpDir: string): string | null {
  const outPath = path.join(tmpDir, 'repaired.epub');

  // 内联的 Python 修复脚本（等价于 scripts/repair_epub.py）
  const inlineScript = `
import zipfile, os, sys, tempfile, shutil

def main():
    src, out = sys.argv[1], sys.argv[2]
    tmp = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(src, 'r') as z:
            names = z.namelist()
            files = [n for n in names if not n.endswith('/')]
            dirs = set(n.split('/')[0] for n in names if '/' in n)

            if len(dirs) != 1:
                print("NO_FIX_NEEDED", flush=True)
                sys.exit(1)

            prefix = list(dirs)[0]
            has_mimetype = any(n == prefix + '/mimetype' for n in names)
            root_has_mimetype = any(n == 'mimetype' for n in names)

            if not (has_mimetype and not root_has_mimetype):
                print("NO_FIX_NEEDED", flush=True)
                sys.exit(1)

            for name in files:
                rel = name[len(prefix)+1:] if name.startswith(prefix+'/') else name
                if not rel: continue
                target = os.path.join(tmp, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as f:
                    f.write(z.read(name))

            with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as out_z:
                for root2, dirs2, files2 in os.walk(tmp):
                    for f in files2:
                        fp = os.path.join(root2, f)
                        rel = os.path.relpath(fp, tmp)
                        compress = zipfile.ZIP_STORED if rel == 'mimetype' else zipfile.ZIP_DEFLATED
                        out_z.write(fp, rel, compress_type=compress)

            if os.path.getsize(out) > 0:
                print("OK:" + out, flush=True)
                shutil.rmtree(tmp, ignore_errors=True)
                return 0

        print("NO_FIX_NEEDED", flush=True)
        shutil.rmtree(tmp, ignore_errors=True)
        return 1
    except Exception as e:
        print("ERR:" + str(e), flush=True)
        shutil.rmtree(tmp, ignore_errors=True)
        return 2

if __name__ == '__main__':
    sys.exit(main())
`;

  try {
    // 写入临时 Python 脚本文件后执行，避免命令行长度/转义问题
    const tmpScript = path.join(tmpDir, 'repair.py');
    fs.writeFileSync(tmpScript, inlineScript);
    const cmd = `python3 "${tmpScript}" "${sourcePath}" "${outPath}"`;
    const result = execSync(cmd, {
      stdio: 'pipe',
      timeout: 15000,
    });
    const output = result.toString().trim();
    if (output.startsWith('OK:')) {
      return outPath;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse EPUB file using the `epub` npm package (reliable XML parsing)
 * while still extracting files via yauzl for content serving.
 *
 * 自动修复"二次包装"的 EPUB：当 ZIP 内的所有文件被嵌套在一个顶层目录
 * （如 `书名.epub/mimetype`→根目录缺少 `mimetype`），会自动将其修复为
 * 符合标准的 EPUB 格式再解析。
 */
export async function parseEpub(epubPath: string, outputDir: string): Promise<EpubParseResult> {
  // ── Step 0: 预处理 — 修复被"二次包装"的 EPUB（内容嵌套在子目录中） ──
  let actualPath = epubPath;
  let cleanupDir: string | null = null;

  try {
    const buf = fs.readFileSync(epubPath);
    const entryNames: string[] = [];

    // 扫描 ZIP 目录
    await new Promise<void>((resolve) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) { resolve(); return; }
        zipfile.readEntry();
        zipfile.on('entry', (entry: any) => {
          entryNames.push(entry.fileName.replace(/\/$/, ''));
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolve());
        zipfile.on('error', () => resolve());
      });
    });

    // 检测是否缺少根目录 mimetype
    if (!entryNames.some(e => e === 'mimetype')) {
      const topDirs = new Set(entryNames.map(e => e.split('/')[0]));
      if (topDirs.size === 1) {
        const topDir = [...topDirs][0];
        if (entryNames.some(e => e === `${topDir}/mimetype`)) {
          // 需要修复：读取所有文件，去掉顶层目录前缀
          const fileData = new Map<string, Buffer>();
          await new Promise<void>((resolve) => {
            yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
              if (err || !zipfile) { resolve(); return; }
              zipfile.readEntry();
              zipfile.on('entry', (entry: any) => {
                if (entry.fileName.endsWith('/')) { zipfile.readEntry(); return; }
                const origName = entry.fileName;
                zipfile.openReadStream(entry, (readErr: any, stream: any) => {
                  if (readErr) { zipfile.readEntry(); return; }
                  const chunks: Buffer[] = [];
                  stream.on('data', (c: Buffer) => chunks.push(c));
                  stream.on('end', () => {
                    fileData.set(origName, Buffer.concat(chunks));
                    zipfile.readEntry();
                  });
                });
              });
              zipfile.on('end', () => resolve());
              zipfile.on('error', () => resolve());
            });
          });

          if (fileData.size > 0) {
            // 去掉顶层目录前缀，重建符合标准的 EPUB
            const fixed = new Map<string, Buffer>();
            for (const [k, v] of fileData) {
              const relPath = k.slice(topDir.length + 1);
              if (relPath) fixed.set(relPath, v);
            }

            if (fixed.has('mimetype')) {
              const repairDir = path.join(outputDir, '.epub-repair-' + Date.now());
              fs.mkdirSync(repairDir, { recursive: true });
              const tmpPath = rebuildEpubWithPython(epubPath, repairDir);
              if (tmpPath) {
                actualPath = tmpPath;
                cleanupDir = repairDir;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[EPUB 预处理] 检测/修复失败，使用原始文件:', (e as Error).message);
  }

  // ── Step 1: Use `epub` package for metadata + chapter structure ──
  let epub: any;
  try {
    epub = new EPub(actualPath);
    await epub.parse();
  } catch (err: any) {
    if (cleanupDir) {
      try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch {}
    }
    throw new Error(`Failed to parse EPUB metadata: ${err.message}`);
  }

  const title = epub.metadata?.title || 'Unknown Title';
  const author = epub.metadata?.creator || null;

  // Build TOC title → href map
  const tocTitleMap = buildTocTitleMap(epub.toc || []);

  // Generate chapters from flow (spine items)
  const chapters: EpubChapter[] = [];
  const seenHrefs = new Set<string>();
  let order = 0;

  for (const item of (epub.flow || [])) {
    order++;
    if (!item.href) continue;

    // Resolve href relative to OPF directory (same as epub library does internally)
    const resolvedHref = item.href.startsWith('/') ? item.href.slice(1) : item.href;

    if (seenHrefs.has(resolvedHref)) continue;
    seenHrefs.add(resolvedHref);

    // Title priority: TOC title > flow item title > auto-generated
    let chapterTitle = tocTitleMap.get(resolvedHref) || item.title || '';
    if (!chapterTitle) {
      chapterTitle = `Chapter ${order}`;
    }

    // Detect level from TOC hierarchy if available
    let level = 1;
    for (const tocItem of (epub.toc || [])) {
      if (tocItem.subitems?.length) {
        for (const sub of tocItem.subitems) {
          const subResolved = sub.href
            ? (sub.href.startsWith('/') ? sub.href.slice(1) : sub.href)
            : '';
          if (subResolved === resolvedHref) {
            level = 2;
            break;
          }
        }
      }
    }

    chapters.push({
      id: `ch-${order}`,
      title: chapterTitle,
      href: resolvedHref,
      order,
      level,
    });
  }

  // ── Step 1b: Supplement chapters from TOC for "single-file" EPUBs ──
  // Some EPUBs pack all content into one XHTML file with anchor references
  // (e.g. book collections, compilations). Their spine has only 1-3 items
  // but the TOC (navMap) has rich chapter hierarchy.
  const tocChapters = extractTocChapters(epub.toc || [], order, seenHrefs);
  chapters.push(...tocChapters);
  order += tocChapters.length;

  // ── Step 2: Extract cover image path ──
  let coverPath: string | null = null;

  // Strategy 1: epub.metadata.cover (most reliable)
  if (epub.metadata?.cover) {
    const coverId = epub.metadata.cover;
    if (epub.manifest?.[coverId]?.href) {
      coverPath = epub.manifest[coverId].href.startsWith('/')
        ? epub.manifest[coverId].href.slice(1)
        : epub.manifest[coverId].href;
    }
  }

  // ── Step 3: Extract all files from EPUB using yauzl ──
  const extractedDir = path.join(outputDir, 'extracted');

  await new Promise<void>((resolve, reject) => {
    yauzl.open(actualPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      if (!zipfile) return reject(new Error('Failed to open EPUB'));

      zipfile.readEntry();

      zipfile.on('entry', (entry: any) => {
        const fileName = entry.fileName;

        if (fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (readErr: any, readStream: any) => {
          if (readErr) {
            zipfile.readEntry();
            return;
          }

          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('end', () => {
            const data = Buffer.concat(chunks);
            const targetPath = path.join(extractedDir, fileName);
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.writeFileSync(targetPath, data);
            zipfile.readEntry();
          });
        });
      });

      zipfile.on('end', () => resolve());
      zipfile.on('error', reject);
    });
  });

  return {
    meta: { title, author, coverPath },
    chapters,
    extractedDir,
  };
}
