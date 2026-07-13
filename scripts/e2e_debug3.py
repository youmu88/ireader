#!/usr/bin/env python3
import json, urllib.request, urllib.error
BASE = "http://localhost:10000"
def api(method, path, data=None, token=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(BASE+path, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
st, resp = api("POST", "/api/auth/login", {"email":"admin","password":"admin123"})
token = resp["data"]["token"]
st, resp = api("GET", "/api/books", token=token)
data = resp.get("data", {})
books = data.get("books", data) if isinstance(data, dict) else data
epub = next((b for b in books if b.get("format")=="epub"), books[0])
bid = epub["id"]
print("EPUB id =", bid, "title =", epub.get("title"))
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width":1280,"height":900})
    msgs=[]
    pg.on("console", lambda m: msgs.append(f"[{m.type}] {m.text[:300]}"))
    pg.on("pageerror", lambda e: msgs.append(f"[PAGEERROR] {str(e)[:400]}"))
    pg.goto(f"{BASE}/login", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(1200)
    pg.fill('input[type="text"], input[name="email"]', "admin")
    pg.fill('input[type="password"], input[name="password"]', "admin123")
    pg.click('button:has-text("登录")')
    pg.wait_for_timeout(2500)
    # 用 BrowserRouter 真实路径进入阅读器
    pg.goto(f"{BASE}/reader/{bid}", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(9000)
    print("read页URL:", pg.url)
    print("body文本前200:", repr(pg.inner_text("body")[:200]))
    print("=== 元素计数 ===")
    for sel in ["iframe", ".epub-container", "#viewer", ".reader-content", "iframe.epubjs-iframe", "div[class*='epub' i]", "button", "text=加载中", "[class*='Reader' i]", "[class*='reader' i]", "canvas", ".toolbar", "[class*='Tool' i]"]:
        try:
            c = pg.locator(sel).count()
            if c>0: print(f"  {sel} = {c}")
        except Exception: pass
    print("=== console/error ===")
    for m in msgs[-25:]:
        print("  ", m)
    pg.screenshot(path="/Users/wilsonwen/workspace/ireader/scripts/e2e_reader_shot.png")
    print("截图保存 e2e_reader_shot.png")
    b.close()
