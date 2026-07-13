#!/usr/bin/env python3
import json, urllib.request, urllib.error
BASE = "http://localhost:10000"
def api(method, path, data=None, token=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(BASE+path, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, json.loads(r.read().decode())
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
    allreq=[]
    allresp=[]
    failed=[]
    pg.on("request", lambda r: allreq.append(f"{r.method} {r.url[:150]}"))
    pg.on("response", lambda r: allresp.append(f"{r.status} {r.request.method} {r.url[:150]}"))
    pg.on("requestfailed", lambda r: failed.append(f"FAIL {r.request.method} {r.url[:120]} -> {r.failure}"))
    pg.on("console", lambda m: print(f"[console.{m.type}] {m.text[:300]}"))
    pg.on("pageerror", lambda e: print(f"[PAGEERROR] {str(e)[:400]}"))
    pg.goto(f"{BASE}/login", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(1000)
    pg.fill('input[type="text"], input[name="email"]', "admin")
    pg.fill('input[type="password"], input[name="password"]', "admin123")
    pg.click('button:has-text("登录")')
    pg.wait_for_timeout(2000)
    pg.goto(f"{BASE}/reader/{bid}", wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(15000)
    print("=== 全部请求 ===")
    for r in allreq: print("  REQ", r)
    print("=== 全部响应 ===")
    for r in allresp: print("  RES", r)
    print("=== 失败 ===")
    for f in failed: print("  ", f)
    b.close()
