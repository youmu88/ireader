import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';

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

function extractText(data: string, pattern: RegExp): string | null {
  const m = data.match(pattern);
  return m ? m[1].trim() : null;
}

function extractTextFromXml(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Parse EPUB file and extract metadata + chapters + cover.
 * Returns extracted files directory for frontend to load.
 */
export async function parseEpub(epubPath: string, outputDir: string): Promise<EpubParseResult> {
  return new Promise((resolve, reject) => {
    yauzl.open(epubPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      if (!zipfile) return reject(new Error('Failed to open EPUB'));

      const extractedFiles: Map<string, Buffer> = new Map();
      let containerXml = '';
      let opfContent = '';
      let ncxContent = '';
      let navXhtml = '';
      let opfPath = '';

      zipfile.readEntry();

      zipfile.on('entry', (entry: any) => {
        const fileName = entry.fileName;

        if (entry.fileName.endsWith('/')) {
          // Directory entry, skip
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

            if (fileName === 'META-INF/container.xml') {
              containerXml = data.toString(TEXT_ENCODING);
            } else if (fileName.endsWith('.opf')) {
              opfContent = data.toString(TEXT_ENCODING);
              opfPath = fileName;
            } else if (fileName.endsWith('toc.ncx')) {
              ncxContent = data.toString(TEXT_ENCODING);
            } else if (fileName.includes('toc') && fileName.endsWith('.xhtml')) {
              navXhtml = data.toString(TEXT_ENCODING);
            }

            // Store extracted files for later serving
            extractedFiles.set(fileName, data);
            zipfile.readEntry();
          });
        });
      });

      zipfile.on('end', async () => {
        try {
          // Resolve OPF path from container.xml if needed
          if (!opfContent && containerXml) {
            const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
            if (rootfileMatch) {
              const resolvedOpfPath = rootfileMatch[1];
              const opfBuf = extractedFiles.get(resolvedOpfPath);
              if (opfBuf) {
                opfContent = opfBuf.toString(TEXT_ENCODING);
                opfPath = resolvedOpfPath;
              }
            }
          }

          if (!opfContent) {
            throw new Error('Could not find OPF file in EPUB');
          }

          // Extract metadata
          const title = extractTextFromXml(opfContent, 'dc:title')
            || extractText(opfContent, /<title[^>]*>([^<]+)<\/title>/i)
            || 'Unknown Title';
          const author = extractTextFromXml(opfContent, 'dc:creator')
            || extractTextFromXml(opfContent, 'dc:contributor');

          // Extract cover — multiple strategies
          let coverPath: string | null = null;

          // Strategy 1: <meta name="cover" content="cover-id">
          const coverMetaMatch = opfContent.match(/<meta[^>]*name="cover"[^>]*content="([^"]+)"[^>]*\/?>/i);
          if (coverMetaMatch) {
            const coverId = coverMetaMatch[1];
            const coverHrefMatch = opfContent.match(new RegExp(`<item[^>]*id="${coverId}"[^>]*href="([^"]+)"`));
            if (coverHrefMatch) {
              coverPath = path.join(path.dirname(opfPath), coverHrefMatch[1]);
            }
          }

          // Strategy 2: <item properties="cover-image">
          if (!coverPath) {
            const coverItemMatch = opfContent.match(/<item[^>]+properties="[^"]*cover-image[^"]*"[^>]*href="([^"]+)"/i);
            if (coverItemMatch) {
              coverPath = path.join(path.dirname(opfPath), coverItemMatch[1]);
            }
          }

          // Strategy 3: item with id containing "cover"
          if (!coverPath) {
            const coverIdMatch = opfContent.match(/<item[^>]+id="([^"]*cover[^"]*)"[^>]*href="([^"]+)"/i);
            if (coverIdMatch) {
              coverPath = path.join(path.dirname(opfPath), coverIdMatch[2]);
            }
          }

          // Strategy 4: first image in manifest
          if (!coverPath) {
            const firstImage = opfContent.match(/<item[^>]+media-type="image\/[^"]+"[^>]*href="([^"]+)"/i);
            if (firstImage) {
              coverPath = path.join(path.dirname(opfPath), firstImage[1]);
            }
          }

          // Extract chapters from NCX or nav
          const chapters: EpubChapter[] = [];
          const seenHrefs = new Set<string>();

          if (ncxContent) {
            // Parse NCX TOC
            const navPointRegex = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi;
            let navMatch;
            let order = 0;

            const parseNavPoints = (xml: string, parentLevel: number): void => {
              const navPointRegex2 = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi;
              let m;
              while ((m = navPointRegex2.exec(xml)) !== null) {
                order++;
                const content = m[1];
                const titleMatch = content.match(/<navLabel>\s*<text>([^<]*)<\/text>\s*<\/navLabel>/i);
                const hrefMatch = content.match(/<content[^>]*src="([^"]+)"/i);
                if (titleMatch && hrefMatch) {
                  const href = hrefMatch[1];
                  // Resolve relative path against OPF directory
                  const resolvedHref = path.posix.join(path.dirname(opfPath), href);
                  if (!seenHrefs.has(resolvedHref)) {
                    seenHrefs.add(resolvedHref);
                    chapters.push({
                      id: `ch-${order}`,
                      title: titleMatch[1].trim(),
                      href: resolvedHref,
                      order,
                      level: parentLevel,
                    });
                  }
                }
                // Recursively parse child navPoints
                const childrenMatch = content.match(/<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi);
                if (childrenMatch && childrenMatch.length > 0) {
                  parseNavPoints(content, parentLevel + 1);
                }
              }
            };

            parseNavPoints(ncxContent, 1);
          } else if (navXhtml) {
            // Parse XHTML nav
            const navRegex = /<nav[^>]*>([\s\S]*?)<\/nav>/gi;
            const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
            let order = 0;

            const navs = navXhtml.match(navRegex);
            if (navs) {
              for (const nav of navs) {
                const items = [...nav.matchAll(listItemRegex)];
                for (const item of items) {
                  order++;
                  const linkMatch = item[1].match(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/i);
                  if (linkMatch) {
                    const href = linkMatch[1];
                    const resolvedHref = path.posix.join(path.dirname(opfPath), href);
                    if (!seenHrefs.has(resolvedHref)) {
                      seenHrefs.add(resolvedHref);
                      chapters.push({
                        id: `ch-${order}`,
                        title: linkMatch[2].trim(),
                        href: resolvedHref,
                        order,
                        level: 1,
                      });
                    }
                  }
                }
              }
            }
          }

          // Fallback: use spine itemrefs as chapters
          if (chapters.length === 0) {
            const spineRefs = [...opfContent.matchAll(/<itemref[^>]*idref="([^"]+)"[^>]*\/?>/gi)];
            let order = 0;
            for (const ref of spineRefs) {
              order++;
              const itemMatch = opfContent.match(new RegExp(`<item[^>]*id="${ref[1]}"[^>]*href="([^"]+)"`));
              if (itemMatch) {
                const href = path.posix.join(path.dirname(opfPath), itemMatch[1]);
                chapters.push({
                  id: `ch-${order}`,
                  title: `Chapter ${order}`,
                  href,
                  order,
                  level: 1,
                });
              }
            }
          }

          // Save extracted files to output directory
          const extractedDir = path.join(outputDir, 'extracted');
          if (!fs.existsSync(extractedDir)) {
            fs.mkdirSync(extractedDir, { recursive: true });
          }
          for (const [filePath, content] of extractedFiles) {
            const targetPath = path.join(extractedDir, filePath);
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            fs.writeFileSync(targetPath, content);
          }

          resolve({
            meta: { title, author, coverPath },
            chapters,
            extractedDir,
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      });

      zipfile.on('error', reject);
    });
  });
}
