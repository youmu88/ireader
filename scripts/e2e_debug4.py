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
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width":1280,"height":900})
    reqs=[]
    failed=[]
    pg.on("requestfailed", lambda r: failed.append(f"FAIL {r.method} {r.url[:120]} -> {r.failure}"))
    pg.on("response", lambda r: reqs.append(f"{r.status} {r.request.method} {r.url[:140]}") if r.url.startswith(BASE) else None)
    pg.on("pageerror", lambda e: failed.append(f"PAGEERROR {str(e)[:300]}"))
    pg.goto(f"{BASE}/login", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(1000)
    pg.fill('input[type="text"], input[name="email"]', "admin")
    pg.fill('input[type="password"], input[name="password"]', "admin123")
    pg.click('button:has-text("登录")')
    pg.wait_for_timeout(2000)
    pg.goto(f"{BASE}/reader/{bid}", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(10000)
    print("=== 同源请求(后20条) ===")
    for r in reqs[-20:]:
        print("  ", r)
    print("=== 失败请求 ===")
    for f in failed[-20:]:
        print("  ", f)
    # 看 EpubViewer 挂载的 DOM
    print("=== div[class*=epub] 的外层HTML ===")
    try:
        html = pg.eval_on_selector("div[class*='epub' i]", "el => el.outerHTML.slice(0,600)")
        print(html)
    except Exception as e:
        print("  eval失败:", e)
    b.close()
