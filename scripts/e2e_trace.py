import json, urllib.request
from playwright.sync_api import sync_playwright
BASE="http://localhost:10000"
def post(p,d):
    r=urllib.request.Request(BASE+p,data=json.dumps(d).encode(),headers={"Content-Type":"application/json"},method="POST")
    return json.loads(urllib.request.urlopen(r,timeout=20).read())
def get(p,t):
    r=urllib.request.Request(BASE+p,headers={"Authorization":"Bearer "+t})
    return json.loads(urllib.request.urlopen(r,timeout=20).read())
tok=post("/api/auth/login",{"email":"admin","password":"admin123"})["data"]["token"]
resp=get("/api/books",tok)["data"]
books=resp["books"] if isinstance(resp,dict) and "books" in resp else resp
bid=[b["id"] for b in books if b.get("format")=="epub"][0]
print("EPUB id:",bid)
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    pg=b.new_page(viewport={"width":1280,"height":900})
    fail=[]
    pg.on("response", lambda r: fail.append(f"{r.status} {r.request.method} {r.url[:160]}") if r.status>=400 else None)
    pg.goto(BASE+"/login", wait_until="networkidle")
    pg.fill('input[type="text"]',"admin"); pg.fill('input[type="password"]',"admin123")
    pg.click('button:has-text("登录")'); pg.wait_for_timeout(2000)
    pg.goto(BASE+"/reader/"+bid, wait_until="networkidle")
    pg.wait_for_timeout(10000)
    print("=== >=400 的响应 ===")
    for f in fail: print("  ",f)
    try:
        frame=pg.frames[1]
        txt=frame.inner_text("body")[:400]
        print("=== iframe 内文字(前400) ===")
        print(repr(txt))
    except Exception as e:
        print("iframe文字读取失败:",e)
    b.close()
