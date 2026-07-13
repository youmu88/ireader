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
st, resp = api("GET", "/api/books")  # 未登录先拿书籍id不行,需登录
st, resp = api("POST", "/api/auth/login", {"email":"admin","password":"admin123"})
token = resp["data"]["token"]
st, resp = api("GET", "/api/books", token=token)
data = resp.get("data", {})
books = data.get("books", data) if isinstance(data, dict) else data
epub = next((b for b in books if b.get("format")=="epub"), books[0])
bid = epub["id"]
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width":1280,"height":900})
    msgs=[]
    pg.on("console", lambda m: msgs.append(f"[{m.type}] {m.text[:300]}"))
    pg.on("pageerror", lambda e: msgs.append(f"[PAGEERROR] {str(e)[:300]}"))
    # 1) 打开登录页
    pg.goto(f"{BASE}/login", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(1500)
    # 2) 页面内登录
    pg.fill('input[type="text"], input[name="email"], input[placeholder*="邮箱"]', "admin")
    pg.fill('input[type="password"], input[name="password"]', "admin123")
    pg.click('button:has-text("登录")')
    pg.wait_for_timeout(3000)
    print("=== 登录后URL ===", pg.url)
    print("=== localStorage token? ===", pg.evaluate("localStorage.getItem('ireader_auth_token') ? 'YES' : 'NO'"))
    # 3) 进阅读器
    pg.goto(f"{BASE}/#/read/{bid}", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(8000)
    print("=== read页URL ===", pg.url)
    print("=== body可见文本(前300) ===", repr(pg.inner_text("body")[:300]))
    print("=== 元素计数 ===")
    for sel in ["iframe", ".epub-container", "#viewer", ".reader-content", "iframe.epubjs-iframe", "div[class*='epub']", "button", "text=加载中", "[class*='viewer']", "[class*='Reader']", "[class*='reader']", "canvas"]:
        try:
            c = pg.locator(sel).count()
            if c>0: print(f"  {sel} = {c}")
        except: pass
    print("=== console/error ===")
    for m in msgs[-25:]:
        print("  ", m)
    pg.screenshot(path="/Users/wilsonwen/workspace/ireader/scripts/e2e_debug.png", full_page=False)
    print("=== 截图 e2e_debug.png ===")
    b.close()
