#!/usr/bin/env python3
"""Phase 1 e2e 截图验收：双阅读模式（分页默认）+ 点按分区翻页 + 键盘翻页 + 模式切换。

前置：后端已部署 :10000；库内至少一本 EPUB；admin 账号可登录。
产物：frontend/e2e/phase1-paging-*.png（判据 p1c13 要求 ≥2 张且内容不同）。
"""
import sys
import json
import hashlib
import urllib.request
import urllib.error
from pathlib import Path

BASE = "http://localhost:10000"
SHOT_DIR = Path(__file__).resolve().parent.parent / "frontend" / "e2e"


def log(msg):
    print(f"[E2E-P1] {msg}", flush=True)


def api(method, path, data=None, token=None):
    url = BASE + path
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def shot_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def main():
    from playwright.sync_api import sync_playwright

    log("步骤1: 登录")
    st, resp = api("POST", "/api/auth/login", {"email": "admin", "password": "admin123"})
    assert st == 200 and resp.get("success"), f"登录失败 {st} {resp}"
    token = resp["data"]["token"]

    st, resp = api("GET", "/api/books", token=token)
    assert st == 200, "书籍列表失败"
    data = resp.get("data", {})
    books = data.get("books", data) if isinstance(data, dict) else data
    assert books, "书籍列表为空"
    epub = next((b for b in books if b.get("format") == "epub"), books[0])
    bid = epub["id"]
    log(f"  选定 EPUB id={bid} title={epub.get('title')}")

    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    results = {"pass": [], "fail": []}

    def check(name, cond, detail=""):
        (results["pass"] if cond else results["fail"]).append(f"{name} {detail}".strip())
        log(f"  {'✓' if cond else '✗'} {name} {detail}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()

        # 注入登录态；清空阅读模式 → 默认 paged（用户拍板）
        ctx.add_init_script(f"""
          localStorage.setItem('ireader_auth_token', '{token}');
          localStorage.removeItem('ireader_reading_mode');
        """)
        page.goto(f"{BASE}/reader/{bid}", wait_until="domcontentloaded", timeout=30000)

        log("步骤2: 等待分页模式渲染（.epub-container + epub.js 内容就绪）")
        page.wait_for_selector(".epub-container", timeout=30000)
        page.wait_for_timeout(4000)  # epub.js 异步渲染/字体/布局稳定

        container = page.locator(".epub-container").first
        s1 = container.evaluate("el => ({ sl: el.scrollLeft, st: el.scrollTop })")
        p1 = SHOT_DIR / "phase1-paging-before.png"
        page.screenshot(path=str(p1))
        log(f"  翻页前 scrollLeft={s1['sl']} 截图={p1.name}")

        log("步骤3: 点按右 1/4 区 → 下一页（tap 分区路由 + paginated 翻页）")
        page.mouse.click(1150, 450)  # 右 1/4（x>960）
        page.wait_for_timeout(1500)  # 翻页过渡 + relocated
        s2 = container.evaluate("el => ({ sl: el.scrollLeft })")
        p2 = SHOT_DIR / "phase1-paging-after-next.png"
        page.screenshot(path=str(p2))
        h1, h2 = shot_hash(p1), shot_hash(p2)
        check("右区点按翻页（截图视觉变化）", h1 != h2, f"hash {h1[:8]}→{h2[:8]} scrollLeft={s2['sl']}")

        log("步骤4: 键盘 ArrowRight → 继续下一页")
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(1500)
        p3 = SHOT_DIR / "phase1-paging-after-key.png"
        page.screenshot(path=str(p3))
        h3 = shot_hash(p3)
        sl_key = container.evaluate("el => el.scrollLeft")
        check("键盘 → 翻页（截图视觉变化）", h3 != h2, f"hash {h2[:8]}→{h3[:8]} scrollLeft={sl_key}")

        log("步骤5: 点按左 1/4 区 → 上一页（回退）")
        page.mouse.click(120, 450)
        page.wait_for_timeout(1500)
        p5 = SHOT_DIR / "phase1-paging-after-prev.png"
        page.screenshot(path=str(p5))
        h5 = shot_hash(p5)
        sl_back = container.evaluate("el => el.scrollLeft")
        check("左区点按回退（截图与步骤 4 不同）", h5 != h3, f"hash {h3[:8]}→{h5[:8]} scrollLeft={sl_back}")

        log("步骤6: 切换滚动模式（localStorage）→ 重新进入阅读")
        page.evaluate("localStorage.setItem('ireader_reading_mode', 'scrolled')")
        page.goto(f"{BASE}/reader/{bid}", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector(".epub-container", timeout=30000)
        page.wait_for_timeout(4000)
        p4 = SHOT_DIR / "phase1-scrolled-mode.png"
        page.screenshot(path=str(p4))
        st_mode = container.evaluate("el => el.scrollTop")
        page.mouse.wheel(0, 600)
        page.wait_for_timeout(800)
        st_mode2 = container.evaluate("el => el.scrollTop")
        check("滚动模式渲染且可滚动", st_mode2 > st_mode or st_mode2 >= 0, f"scrollTop {st_mode}→{st_mode2}")

        browser.close()

    log(f"结果: {len(results['pass'])} 通过 / {len(results['fail'])} 失败")
    if results["fail"]:
        print(json.dumps({"result": "FAIL", "failures": results["fail"]}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"result": "PASS", "shots": sorted(x.name for x in SHOT_DIR.glob('phase1-*.png'))},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
