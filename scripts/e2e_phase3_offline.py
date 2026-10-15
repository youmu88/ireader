#!/usr/bin/env python3
"""Phase 3 e2e 离线验收：书架下载 EPUB+TXT → 断网刷新 / 断网重开 / 断网直进阅读器 三场景。

前置：后端已部署（含 Phase 3 改动）；库内至少一本 EPUB 与一本 TXT；admin 可登录。
产物：frontend/e2e/phase3-offline-*.png（判据 C9 要求 ≥1 张）。
说明：断网重开（新开 page）依赖 Service Worker 已激活 + App Shell 已预缓存；
首访页面需先在线 reload 一次，使静态资源经 SW 进入运行时缓存（否则离线时 JS chunk 无缓存）。
"""
import re
import sys
import json
import urllib.request
import urllib.error
from pathlib import Path

BASE = "http://localhost:10000"
SHOT_DIR = Path(__file__).resolve().parent.parent / "frontend" / "e2e"

# 诊断收集：console/pageerror 日志（失败时输出关键片段）
console_logs = []


def dump_idb(pg, book_id, label):
    """诊断：读取 IndexedDB cacheMeta 与该书 bookChapters 计数（任意页面可执行）。"""
    try:
        info = pg.evaluate(
            """async (bid) => {
              const openDb = () => new Promise((res, rej) => { const r = indexedDB.open('ireader_cache'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
              try {
                const db = await openDb();
                const meta = await new Promise((res) => { const tx = db.transaction('cacheMeta','readonly'); const rq = tx.objectStore('cacheMeta').get(bid); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
                const cnt = await new Promise((res) => { const tx = db.transaction('bookChapters','readonly'); const rq = tx.objectStore('bookChapters').index('bookId').count(bid); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(-1); });
                return { stores: Array.from(db.objectStoreNames), chapters: cnt, meta: meta };
              } catch (e) { return { error: String(e) }; }
            }""",
            book_id,
        )
        meta = info.get("meta")
        log(f"  IDB[{label}]: chapters={info.get('chapters')} stores={info.get('stores')}")
        log(f"  IDB[{label}].meta={json.dumps(meta, ensure_ascii=False)[:400] if meta else info}")
    except Exception as e:
        log(f"  IDB[{label}] dump 失败: {str(e)[:120]}")


def log(msg):
    print(f"[E2E-P3] {msg}", flush=True)


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


def main():
    from playwright.sync_api import sync_playwright

    log("步骤1: 登录 + 选书")
    st, resp = api("POST", "/api/auth/login", {"email": "admin", "password": "admin123"})
    assert st == 200 and resp.get("success"), f"登录失败 {st} {resp}"
    token = resp["data"]["token"]

    st, resp = api("GET", "/api/books", token=token)
    assert st == 200, "书籍列表失败"
    data = resp.get("data", {})
    books = data.get("books", data) if isinstance(data, dict) else data
    epub = next((b for b in books if b.get("format") == "epub" and b.get("status") == "ready"), None)
    txt = next((b for b in books if b.get("format") == "txt" and b.get("status") == "ready"), None)
    assert epub, "库内无 ready 的 EPUB 书籍"
    assert txt, "库内无 ready 的 TXT 书籍"
    log(f"  EPUB: {epub['id'][:8]} {epub.get('title')}")
    log(f"  TXT : {txt['id'][:8]} {txt.get('title')}")

    results = {"pass": [], "fail": []}

    def check(name, cond, detail=""):
        (results["pass"] if cond else results["fail"]).append(f"{name} {detail}".strip())
        log(f"  {'✓' if cond else '✗'} {name} {detail}")

    SHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx.add_init_script(f"localStorage.setItem('ireader_auth_token', '{token}');")
        page = ctx.new_page()
        page.on("console", lambda m: console_logs.append(f"[p1][{m.type}] {m.text[:200]}"))
        page.on("pageerror", lambda e: console_logs.append(f"[p1][pageerror] {str(e)[:200]}"))

        # ── 在线：图书管理页批量缓存 EPUB + TXT（真实下载写 IndexedDB）──
        log("步骤2: 打开 /library 勾选两本书并批量缓存")
        page.goto(f"{BASE}/library", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector(f'[data-testid="select-{epub["id"]}"]', timeout=30000)
        page.locator(f'[data-testid="select-{epub["id"]}"]').first.click()
        page.locator(f'[data-testid="select-{txt["id"]}"]').first.click()
        cache_btn = page.get_by_text("缓存离线包", exact=False).first
        cache_btn.wait_for(state="visible", timeout=10000)
        cache_btn.click()

        log("步骤3: 等待下载完成（最长 240s）")
        downloaded = False
        try:
            page.wait_for_selector("text=/已将 \\d+ 本书缓存到本地/", timeout=240000)
            downloaded = True
        except Exception:
            pass
        body_text = page.inner_text("body")[:400].replace("\n", " | ")
        check("批量缓存成功提示", downloaded, f"页面摘要: {body_text[:160]}")
        dump_idb(page, txt["id"], "online-TXT下载后")
        dump_idb(page, epub["id"], "online-EPUB下载后")
        page.screenshot(path=str(SHOT_DIR / "phase3-offline-cache-done.png"))
        if not downloaded:
            log("下载未成功，后续离线场景大概率失败，继续执行收集证据")

        # ── 在线 reload：让 SW 接管 + 静态资源进入运行时缓存 ──
        log("步骤4: 在线 reload → SW 接管检查")
        try:
            page.wait_for_function(
                "async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }",
                timeout=20000,
            )
            sw_active = True
        except Exception:
            sw_active = False
        check("SW 已激活（registration.active）", sw_active)

        def wait_controller(timeout_ms=20000):
            try:
                page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=timeout_ms)
                return True
            except Exception:
                return False

        page.reload(wait_until="domcontentloaded")
        controlled = wait_controller()
        if not controlled:
            # SW 可能刚激活尚未接管本页；再 reload 一次
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            controlled = wait_controller()
        check("SW 已接管页面（controller 存在）", controlled)

        # ── 对照实验：在线打开 TXT 阅读器（判定“在线路径是否正常” + 预热阅读器资源）──
        log("步骤4.5: 在线打开 TXT 阅读器（对照）")
        page.goto(f"{BASE}/reader/{txt['id']}", wait_until="domcontentloaded", timeout=30000)
        online_reader_ok = False
        for _ in range(60):
            try:
                probe_texts = [page.inner_text("body")]
                for fr in page.frames:
                    try:
                        probe_texts.append(fr.inner_text("body"))
                    except Exception:
                        continue
                if any("离线阅读验收的测试正文" in t for t in probe_texts):
                    online_reader_ok = True
                    break
            except Exception:
                pass
            page.wait_for_timeout(500)
        check("在线打开 TXT 阅读器（对照：正文渲染）", online_reader_ok)
        if not online_reader_ok:
            _t = page.inner_text("body")[:240].replace("\n", " | ")
            log(f"  在线对照探测未命中：{_t}")
            _logs = [m for m in console_logs if "error" in m or "pageerror" in m]
            log(f"  console 错误尾巴: {json.dumps(_logs[-6:], ensure_ascii=False)[:700]}")
        page.goto(f"{BASE}/library", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(800)

        try:
            ctx.set_offline(True)
            log("步骤5: 已断网 → 场景A 刷新进入书架（/）")
            page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3500)
            text_a = page.inner_text("body")
            cache_title = txt.get("title") or ""
            hit_a = cache_title and cache_title in text_a
            check("场景A 断网刷新：书架渲染出已缓存书籍", bool(hit_a), f"找 '{cache_title[:24]}'")
            page.screenshot(path=str(SHOT_DIR / "phase3-offline-shelf-reload.png"))

            log("步骤6: 场景B 断网重开（新开页面 → 冷启动导航经 SW 拦截）")
            page2 = ctx.new_page()
            page2.on("console", lambda m: console_logs.append(f"[p2][{m.type}] {m.text[:200]}"))
            page2.on("pageerror", lambda e: console_logs.append(f"[p2][pageerror] {str(e)[:200]}"))
            page2.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=30000)
            page2.wait_for_timeout(3500)
            text_b = page2.inner_text("body")
            hit_b = cache_title and cache_title in text_b
            check("场景B 断网重开：书架渲染出已缓存书籍", bool(hit_b), f"找 '{cache_title[:24]}'")
            page2.screenshot(path=str(SHOT_DIR / "phase3-offline-reopen.png"))

            log("步骤7: 场景C 断网直进阅读器（TXT 管道离线组装）")
            page.goto(f"{BASE}/reader/{txt['id']}", wait_until="domcontentloaded", timeout=30000)
            banner_ok = False
            try:
                page.wait_for_selector('[data-testid="offline-banner"]', timeout=30000)
                banner_ok = True
            except Exception:
                pass
            page.wait_for_timeout(2500)
            check("场景C 离线横幅（offline-banner）出现", banner_ok)
            # 正文内容探测（TXT 渲染在 iframe/容器内；标题不在正文 DOM，探测正文句子 + 轮询最多 40s，覆盖 loadTxt 20s 超时兜底窗口）
            content_ok = False
            error_text = None
            probe = "离线阅读验收的测试正文"
            for _ in range(80):
                try:
                    texts = [page.inner_text("body")]
                    for fr in page.frames:
                        try:
                            texts.append(fr.inner_text("body"))
                        except Exception:
                            continue
                    if any(probe in t for t in texts):
                        content_ok = True
                        break
                    if any("书籍加载失败" in t for t in texts):
                        error_text = next(t for t in texts if "书籍加载失败" in t)[:150]
                        break
                except Exception:
                    pass
                page.wait_for_timeout(500)
            if error_text:
                log(f"  错误页出现: {error_text}")
            if not content_ok:
                main_snip = page.inner_text("body")[:200].replace("\n", " | ")
                frame_snips = []
                for i, fr in enumerate(page.frames):
                    try:
                        frame_snips.append(f"F{i}:{fr.inner_text('body')[:80]!r}")
                    except Exception:
                        frame_snips.append(f"F{i}:err")
                log(f"  正文探测未命中；主页面={main_snip} frames={frame_snips[:3]}")
            check("场景C 离线正文渲染（章节文本存在）", content_ok)
            if not content_ok:
                dump_idb(page, txt["id"], "offline-失败现场")
                key_logs = [m for m in console_logs if "error" in m or "pageerror" in m]
                log(f"  console 错误尾巴: {json.dumps(key_logs[-8:], ensure_ascii=False)[:900]}")
            page.screenshot(path=str(SHOT_DIR / "phase3-offline-reader-txt.png"))

            log("步骤8: 场景D（附加）断网直进 EPUB 阅读器")
            page.goto(f"{BASE}/reader/{epub['id']}", wait_until="domcontentloaded", timeout=30000)
            epub_ok = False
            try:
                page.wait_for_selector(".epub-container", timeout=30000)
                page.wait_for_timeout(2500)
                epub_ok = page.locator(".epub-container").count() > 0
            except Exception:
                pass
            check("场景D 断网直进 EPUB：渲染容器出现", epub_ok)
            page.screenshot(path=str(SHOT_DIR / "phase3-offline-reader-epub.png"))
        finally:
            try:
                ctx.set_offline(False)
            except Exception:
                pass

        browser.close()

    log(f"结果: {len(results['pass'])} 通过 / {len(results['fail'])} 失败")
    shots = sorted(x.name for x in SHOT_DIR.glob("phase3-offline-*.png"))
    log(f"截图: {shots}")
    if results["fail"]:
        print(json.dumps({"result": "FAIL", "failures": results["fail"], "shots": shots}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"result": "PASS", "shots": shots}, ensure_ascii=False))


if __name__ == "__main__":
    main()
