import fs from 'fs';
import path from 'path';
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
 * Parse EPUB file using the `epub` npm package (reliable XML parsing)
 * while still extracting files via yauzl for content serving.
 */
export async function parseEpub(epubPath: string, outputDir: string): Promise<EpubParseResult> {
  // ── Step 1: Use `epub` package for metadata + chapter structure ──
  let epub: any;
  try {
    epub = new EPub(epubPath);
    await epub.parse();
  } catch (err: any) {
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
    // Simple level heuristic: check if TOC has nesting for this href
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
    yauzl.open(epubPath, { lazyEntries: true }, (err, zipfile) => {
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
