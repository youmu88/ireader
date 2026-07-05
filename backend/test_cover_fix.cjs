const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');
const { execSync } = require('child_process');
const EPub = require('epub').EPub;

const epubPath = '/home/ubuntu/.ireader/data/books/9653c28f-8473-43a7-8ab3-50858babb713/original.epub';
const tmpDir = '/tmp/test_epub_flow';
fs.mkdirSync(tmpDir, { recursive: true });

let actualPath = epubPath;
const buf = fs.readFileSync(epubPath);
const entryNames = [];

function scanZip() {
  return new Promise((resolve) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { resolve(); return; }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        entryNames.push(entry.fileName.replace(/\/$/, ''));
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', () => resolve());
    });
  });
}

async function main() {
  await scanZip();
  console.log('检测: 根目录mimetype=', entryNames.some(e => e === 'mimetype'));
  const topDirs = new Set(entryNames.map(e => e.split('/')[0]));
  console.log('顶层目录:', [...topDirs]);

  if (!entryNames.some(e => e === 'mimetype') && topDirs.size === 1) {
    const topDir = [...topDirs][0];
    console.log('需要修复, 顶层目录:', topDir);
    
    const repairScriptPath = path.join(tmpDir, 'repair.py');
    const pyScript = `
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
                print('NO_FIX_NEEDED', flush=True); sys.exit(1)
            prefix = list(dirs)[0]
            has_mimetype = any(n == prefix + '/mimetype' for n in names)
            root_has_mimetype = any(n == 'mimetype' for n in names)
            if not (has_mimetype and not root_has_mimetype):
                print('NO_FIX_NEEDED', flush=True); sys.exit(1)
            for name in files:
                rel = name[len(prefix)+1:] if name.startswith(prefix+'/') else name
                if not rel: continue
                target = os.path.join(tmp, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as f: f.write(z.read(name))
            with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as out_z:
                for r, ds, fs_local in os.walk(tmp):
                    for f_name in fs_local:
                        fp = os.path.join(r, f_name)
                        rel = os.path.relpath(fp, tmp)
                        compress = zipfile.ZIP_STORED if rel == 'mimetype' else zipfile.ZIP_DEFLATED
                        out_z.write(fp, rel, compress_type=compress)
            if os.path.getsize(out) > 0:
                print('OK:' + out, flush=True)
                shutil.rmtree(tmp, ignore_errors=True); return 0
        print('NO_FIX_NEEDED', flush=True)
        shutil.rmtree(tmp, ignore_errors=True); return 1
    except Exception as e:
        print('ERR:' + str(e), flush=True)
        shutil.rmtree(tmp, ignore_errors=True); return 2
if __name__ == '__main__':
    sys.exit(main())
`;
    fs.writeFileSync(repairScriptPath, pyScript);
    
    const outPath = path.join(tmpDir, 'repaired.epub');
    const cmd = 'python3 "' + repairScriptPath + '" "' + epubPath + '" "' + outPath + '"';
    const result = execSync(cmd, { stdio: 'pipe', timeout: 15000 });
    const output = result.toString().trim();
    console.log('修复输出:', output);
    
    if (output.startsWith('OK:')) {
      actualPath = outPath;
      console.log('✅ 修复成功, 使用修复后文件:', actualPath);
    } else {
      console.log('❌ 修复失败, 使用原始文件');
    }
  }

  // Step 1: EPUB 解析
  try {
    const epub = new EPub(actualPath);
    await epub.parse();
    console.log('✅ EPUB解析成功');
    console.log('标题:', epub.metadata?.title);
    console.log('封面coverID:', epub.metadata?.cover);
    
    let coverHref = null;
    if (epub.metadata?.cover && epub.manifest?.[epub.metadata.cover]) {
      coverHref = epub.manifest[epub.metadata.cover].href;
      coverHref = coverHref.startsWith('/') ? coverHref.slice(1) : coverHref;
      console.log('封面文件:', coverHref);
    }
    
    // Step 3: 提取文件（用 actualPath 而不是 epubPath）
    const extractedDir = path.join(tmpDir, 'extracted_final');
    await new Promise((resolve, reject) => {
      yauzl.open(actualPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        if (!zipfile) return reject(new Error('无法打开EPUB'));
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          const fileName = entry.fileName;
          if (fileName.endsWith('/')) { zipfile.readEntry(); return; }
          zipfile.openReadStream(entry, (readErr, readStream) => {
            if (readErr) { zipfile.readEntry(); return; }
            const chunks = [];
            readStream.on('data', chunk => chunks.push(chunk));
            readStream.on('end', () => {
              const data = Buffer.concat(chunks);
              const targetPath = path.join(extractedDir, fileName);
              const targetDir = path.dirname(targetPath);
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(targetPath, data);
              zipfile.readEntry();
            });
          });
        });
        zipfile.on('end', () => resolve());
        zipfile.on('error', reject);
      });
    });
    
    console.log('✅ 文件提取完成');
    console.log('提取文件列表:', fs.readdirSync(extractedDir));
    
    if (coverHref) {
      const coverFilePath = path.join(extractedDir, coverHref);
      console.log('封面文件路径:', coverFilePath);
      if (fs.existsSync(coverFilePath)) {
        const stat = fs.statSync(coverFilePath);
        console.log('✅ 封面文件存在, 大小:', stat.size, 'bytes');
        const header = fs.readFileSync(coverFilePath).slice(0, 4);
        console.log('文件头Magic:', header.toString('hex'));
        if (header.toString('hex').startsWith('ffd8')) console.log('✅ JPEG文件头正确');
        else if (header.toString('hex').startsWith('89504e47')) console.log('✅ PNG文件头正确');
        else console.log('⚠️ 未知文件类型');
      } else {
        console.log('❌ 封面文件不存在在预期路径');
      }
    }
  } catch(e) {
    console.error('❌ 失败:', e.message);
  }
}

main().catch(e => console.error(e));
