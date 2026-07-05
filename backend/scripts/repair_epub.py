import zipfile, os, sys, tempfile, shutil

def main():
    if len(sys.argv) < 3:
        print("Usage: repair_epub.py <src_epub> <out_epub>", flush=True)
        return 1
    
    src = sys.argv[1]
    out = sys.argv[2]
    tmp = tempfile.mkdtemp()
    
    try:
        with zipfile.ZipFile(src, 'r') as z:
            names = z.namelist()
            dirs = set(n.split('/')[0] for n in names if '/' in n)
            files = [n for n in names if not n.endswith('/')]
            
            if len(dirs) == 1:
                prefix = list(dirs)[0]
                has_mimetype = any(n == prefix + '/mimetype' for n in names)
                root_has_mimetype = any(n == 'mimetype' for n in names)
                
                if has_mimetype and not root_has_mimetype:
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
