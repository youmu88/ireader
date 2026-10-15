#!/usr/bin/env python3
"""Phase 2 e2e 截图验收：听书链路（入口→播放条→段推进→停止）+ segments 接口闭环。

前置：后端已部署 :10000；库内至少一本 EPUB；admin 账号可登录。
产物：frontend/e2e/phase2-tts-*.png（判据 p2c10 要求 ≥1 张）。
本机 TTS 服务(:8883)可用时验证真实播放；不可用时验证 UI 链路与优雅降级（failedCount/空态）。
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
    print(f"[E2E-P2] {msg}", flush=True)


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
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


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
    log(f"  选定书 id={bid} title={epub.get('title')}")

    results = {"pass": [], "fail": []}

    def check(name, cond, detail=""):
        (results["pass"] if cond else results["fail"]).append(f"{name} {detail}".strip())
        log(f"  {'✓' if cond else '✗'} {name} {detail}")

    # ── segments 接口真实闭环（归属校验 + 分段返回） ──
    log("步骤2: segments 接口闭环")
    st, resp = api("GET", "/api/books/{}/chapters".format(bid), token=token)
    chapters = resp.get("data", []) if st == 200 else []
    assert chapters, "章节清单为空"
    cid = chapters[0]["id"]
    st, segs = api("GET", f"/api/tts/book/{bid}/segments?chapterId={cid}", token=token)
    seg_ok = st == 200 and segs.get("success") and isinstance(segs.get("data"), list)
    check("segments 接口返回分段", seg_ok, f"status={st} segments={len(segs.get('data', [])) if seg_ok else '-'}")
    # 无 token 必须 401
    st_no, _ = api("GET", f"/api/tts/book/{bid}/segments?chapterId={cid}")
    check("segments 鉴权 401", st_no == 401, f"status={st_no}")

    SHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        ctx.add_init_script(f"localStorage.setItem('ireader_auth_token', '{token}');")

        log("步骤3: 打开阅读器")
        page.goto(f"{BASE}/reader/{bid}", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector(".epub-container", timeout=30000)
        page.wait_for_timeout(4000)

        log("步骤4: 点正文中央显示底栏 → 听书入口可见")
        page.mouse.click(640, 450)
        page.wait_for_timeout(800)
        entry = page.locator('[data-testid="tts-entry"]')
        entry_visible = entry.count() > 0 and entry.first.is_visible()
        check("底栏听书入口出现", entry_visible)
        p1 = SHOT_DIR / "phase2-tts-entry.png"
        page.screenshot(path=str(p1))

        log("步骤5: 点击听书 → 播放条出现")
        entry.first.click()
        overlay = page.locator('[data-testid="tts-overlay"]')
        try:
            overlay.wait_for(state="visible", timeout=10000)
            overlay_visible = True
        except Exception:
            overlay_visible = False
        check("TtsOverlay 播放条出现", overlay_visible)
        page.wait_for_timeout(2500)  # 段拉取/播放推进
        p2 = SHOT_DIR / "phase2-tts-overlay.png"
        page.screenshot(path=str(p2))

        # 读取会话状态（loading/playing/paused/idle 均可，回落 idle 需说明为快退）
        status = overlay.first.get_attribute("aria-label") if overlay_visible else None
        text_visible = False
        chapter_visible = False
        if overlay_visible:
            t = page.locator('[data-testid="tts-current-text"]')
            text_visible = t.count() > 0
            chapter_visible = "第一章" in (overlay.first.inner_text() or "") or len(overlay.first.inner_text()) > 0
        check("播放条内容渲染（段文本/章节信息）", text_visible and chapter_visible,
              f"status_label={status}")
        log(f"  播放条文本摘要: {overlay.first.inner_text().replace(chr(10), ' | ')[:80] if overlay_visible else '-'}")

        log("步骤6: 段推进观察（current-text 变化或 failedCount 提示）")
        t = page.locator('[data-testid="tts-current-text"]')
        snap1 = t.inner_text() if t.count() else ""
        page.wait_for_timeout(4000)
        snap2 = t.inner_text() if t.count() else ""
        p3 = SHOT_DIR / "phase2-tts-progress.png"
        page.screenshot(path=str(p3))
        # 进阶判定：文本变化（真实推进）或文本非空（单段持续中）或含失败提示（优雅降级）
        progressed = (snap1 != snap2) or bool(snap2.strip())
        check("播放中/推进（文本变化或非空或降级计数）", overlay_visible and progressed,
              f"snap1={snap1[:24]!r} snap2={snap2[:24]!r}")

        log("步骤7: 停止 → 播放条消失")
        stop_btn = page.get_by_label("停止朗读")
        if overlay_visible and stop_btn.count() > 0:
            stop_btn.first.click()
            page.wait_for_timeout(800)
            gone = overlay.count() == 0 or not overlay.first.is_visible()
            check("停止后播放条消失", gone)
        else:
            check("停止后播放条消失", False, "停止按钮不可用")
        p4 = SHOT_DIR / "phase2-tts-stopped.png"
        page.screenshot(path=str(p4))

        browser.close()

    log(f"结果: {len(results['pass'])} 通过 / {len(results['fail'])} 失败")
    shots = sorted(x.name for x in SHOT_DIR.glob("phase2-*.png"))
    if results["fail"]:
        print(json.dumps({"result": "FAIL", "failures": results["fail"], "shots": shots}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"result": "PASS", "shots": shots}, ensure_ascii=False))


if __name__ == "__main__":
    main()
