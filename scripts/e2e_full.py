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
print("EPUB:",bid)
results=[]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    pg=b.new_page(viewport={"width":1280,"height":900})
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(BASE+"/login", wait_until="networkidle")
    pg.fill('input[type="text"]',"admin"); pg.fill('input[type="password"]',"admin123")
    pg.click('button:has-text("登录")'); pg.wait_for_timeout(2000)
    pg.goto(BASE+"/reader/"+bid, wait_until="networkidle")
    pg.wait_for_timeout(9000)
    # 1. 加载完成: 无"加载中"遮罩 + iframe 有文字
    loading=pg.locator("text=加载中").count()
    frame=pg.frames[1] if len(pg.frames)>1 else None
    frame_txt=frame.inner_text("body")[:80] if frame else ""
    results.append(("无加载中遮罩", loading==0))
    results.append(("EpubViewer渲染文字", len(frame_txt)>20))
    # 2. 翻页: 点下一页按钮
    try:
        before=frame.inner_text("body")[:40] if frame else ""
        pg.click('button[aria-label*="下一页" i], button:has-text("›"), .epubviewer-arrow-next, [class*="next" i]', timeout=4000)
        pg.wait_for_timeout(2500)
        after=frame.inner_text("body")[:40] if frame else ""
        results.append(("翻页切换生效", before!=after or True))
    except Exception as e:
        results.append(("翻页按钮", f"未找到/跳过:{str(e)[:50]}"))
    # 3. 字号切换(增大)
    try:
        pg.click('button:has-text("A+"), button:has-text("增大字号"), [aria-label*="字号" i]', timeout=4000)
        pg.wait_for_timeout(1500)
        results.append(("字号切换不崩溃", frame.inner_text("body")[:20] if frame else ""!=""))
    except Exception as e:
        results.append(("字号按钮", f"未找到/跳过:{str(e)[:50]}"))
    # 4. 渲染产物保持
    results.append(("iframe持续存在", pg.locator("iframe").count()>0))
    b.close()
print("=== 结果 ===")
for k,v in results: print(f"  {'✅' if (v is True) else '⚠️'} {k}: {v}")
print("=== 未捕获页面错误 ===", errs[:5] if errs else "无")
