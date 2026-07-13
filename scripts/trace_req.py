import json, urllib.request
from playwright.sync_api import sync_playwright
BASE="http://localhost:10000"
def post(path,data):
    req=urllib.request.Request(BASE+path, data=json.dumps(data).encode(), headers={"Content-Type":"application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req,timeout=20).read())
def get(path,token):
    req=urllib.request.Request(BASE+path, headers={"Authorization":"Bearer "+token})
    return json.loads(urllib.request.urlopen(req,timeout=20).read())
tok=post("/api/auth/login",{"email":"admin","password":"admin123"})["data"]["token"]
resp=get("/api/books",tok)
d=resp.get("data")
books=d.get("books",d) if isinstance(d,dict) else d
bid=[b["id"] for b in books if b.get("format")=="epub"][0]
print("EPUB id:",bid)
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    pg=b.new_page()
    seen=[]
    pg.on("request", lambda r: seen.append(r.url))
    pg.goto(BASE+"/login", wait_until="networkidle")
    pg.fill('input[type="text"]',"admin"); pg.fill('input[type="password"]',"admin123")
    pg.click('button:has-text("登录")'); pg.wait_for_timeout(2000)
    pg.goto(BASE+"/reader/"+bid, wait_until="networkidle")
    pg.wait_for_timeout(12000)
    apis=sorted(set(u for u in seen if "/api/books" in u))
    print("=== epub.js 发出的 /api/books 请求 ===")
    for u in apis: print(u)
    b.close()
