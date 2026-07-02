#!/usr/bin/env bash
#
# iReader 自动部署 + Git 归档脚本
# ================================
# 一键完成：类型检查 → 构建 → 测试 → 部署 → Git 提交并推送
#
# 用法:
#   ./scripts/auto-archive-deploy.sh                              # 全流程，自动生成 commit message
#   ./scripts/auto-archive-deploy.sh "fix: 修复EPUB图片丢失"       # 自定义 commit message
#   ./scripts/auto-archive-deploy.sh --skip-tests                  # 跳过测试（仅 typecheck + build + deploy + git）
#   ./scripts/auto-archive-deploy.sh --skip-deploy                 # 跳过部署（仅 typecheck + build + test + git）
#   ./scripts/auto-archive-deploy.sh --dry-run                     # 预览模式（只打印要执行的命令，不执行）
#   ./scripts/auto-archive-deploy.sh --help                        # 显示帮助
#
set -euo pipefail

# ============================================================
# 默认配置
# ============================================================
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT_MESSAGE=""
SKIP_TESTS=false
SKIP_DEPLOY=false
DRY_RUN=false
DEPLOY_SCRIPT="${PROJECT_DIR}/deploy.sh"

# ============================================================
# 帮助信息
# ============================================================
show_help() {
  cat <<'HELP'
iReader 自动部署 + Git 归档脚本

一键完成开发后的全自动流程：类型检查 → 构建 → 测试 → 部署 → Git 归档

用法:
  ./scripts/auto-archive-deploy.sh [选项] [commit-message]

选项:
  --skip-tests       跳过测试阶段（仅 typecheck + build + deploy + git）
  --skip-deploy      跳过部署阶段（仅 typecheck + build + test + git）
  --dry-run          预览模式（仅打印命令，不实际执行）
  --help             显示此帮助

commit-message:
  可选。不提供则自动根据变更文件列表生成。
  示例: ./scripts/auto-archive-deploy.sh "feat: 添加TTS错误提示横幅"

流程:
  1. 类型检查 (npm run typecheck)
  2. 构建      (npm run build)
  3. 测试      (npm test)        ← 可用 --skip-tests 跳过
  4. 部署      (./deploy.sh)     ← 可用 --skip-deploy 跳过
  5. Git 归档  (git add + commit + push)
HELP
  exit 0
}

# ============================================================
# 日志函数
# ============================================================
log() {
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[${timestamp}] $*"
}

log_step() {
  echo ""
  echo "================================================"
  echo "  🚀 Step $1: $2"
  echo "================================================"
}

# ============================================================
# 参数解析
# ============================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)
      SKIP_TESTS=true
      shift
      ;;
    --skip-deploy)
      SKIP_DEPLOY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      show_help
      ;;
    -*)
      echo "错误: 未知参数 '$1'。使用 --help 查看帮助。"
      exit 1
      ;;
    *)
      COMMIT_MESSAGE="$1"
      shift
      ;;
  esac
done

# ============================================================
# 自动生成 commit message
# ============================================================
generate_commit_message() {
  local changed_files
  changed_files="$(cd "${PROJECT_DIR}" && git status --short | grep -v '?? ' | awk '{print $2}' | head -20)"
  local file_count
  file_count="$(cd "${PROJECT_DIR}" && git status --short | grep -v '?? ' | wc -l | tr -d ' ')"
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M')"

  if [ "${file_count}" -eq 0 ]; then
    echo "chore: 自动部署归档 @${timestamp}"
  else
    # 从变更文件中推断主要范围
    local scope=""
    if echo "${changed_files}" | grep -q "backend/"; then scope="${scope}backend "; fi
    if echo "${changed_files}" | grep -q "frontend/"; then scope="${scope}frontend "; fi
    if echo "${changed_files}" | grep -q "deploy.sh"; then scope="${scope}deploy "; fi
    scope="$(echo "${scope}" | tr ' ' ',' | sed 's/,$//')"

    echo "chore(${scope}): 自动部署归档 — ${file_count} 个文件变更 @${timestamp}"
  fi
}

# ============================================================
# 安全执行（支持 dry-run）
# ============================================================
run() {
  if [ "${DRY_RUN}" = true ]; then
    echo "  🔍 [DRY-RUN] $*"
    return 0
  fi
  eval "$@"
}

# ============================================================
# 前置检查
# ============================================================
check_prerequisites() {
  log "检查前置条件..."

  # 在项目根目录
  cd "${PROJECT_DIR}"

  # 检查 git
  if ! command -v git &>/dev/null; then
    echo "错误: 未找到 git 命令。"
    exit 1
  fi
  log "git ✓"

  # 检查 deploy.sh
  if [ "${SKIP_DEPLOY}" = false ] && [ ! -f "${DEPLOY_SCRIPT}" ]; then
    echo "错误: 未找到 deploy.sh (${DEPLOY_SCRIPT})。"
    exit 1
  fi
  log "deploy.sh ✓"

  # 检查是否有未暂存的变更（没有变更就没必要归档）
  local has_changes
  has_changes="$(cd "${PROJECT_DIR}" && git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')"
  if [ "${has_changes}" -eq 0 ]; then
    log "⚠️  没有检测到文件变更，跳过 git 归档阶段"
  fi
}

# ============================================================
# 主流程
# ============================================================
main() {
  echo ""
  echo "╔════════════════════════════════════════════════╗"
  echo "║   📚 iReader 自动部署 & Git 归档              ║"
  echo "║   $(date)              ║"
  echo "╚════════════════════════════════════════════════╝"
  echo ""

  if [ "${DRY_RUN}" = true ]; then
    log "🔍 DRY-RUN 模式 — 仅预览，不执行实际命令"
    echo ""
  fi

  check_prerequisites

  # Step 1: 类型检查
  log_step "1/5" "类型检查 (npm run typecheck)"
  if ! run "cd \"${PROJECT_DIR}\" && npm run typecheck 2>&1"; then
    echo "❌ 类型检查失败，终止流程。请修复 TypeScript 错误后重试。"
    exit 1
  fi
  log "类型检查通过 ✓"

  # Step 2: 构建
  log_step "2/5" "构建项目 (npm run build)"
  if ! run "cd \"${PROJECT_DIR}\" && npm run build 2>&1"; then
    echo "❌ 构建失败，终止流程。请修复构建错误后重试。"
    exit 1
  fi
  log "构建完成 ✓"

  # Step 3: 测试（可选跳过）
  if [ "${SKIP_TESTS}" = false ]; then
    log_step "3/5" "运行测试 (npm test)"
    if ! run "cd \"${PROJECT_DIR}\" && npm test 2>&1"; then
      echo "❌ 测试失败，终止流程。请修复测试后重试。"
      exit 1
    fi
    log "全部测试通过 ✓"
  else
    log_step "3/5" "⏭️  跳过测试 (--skip-tests)"
  fi

  # Step 4: 部署（可选跳过）
  if [ "${SKIP_DEPLOY}" = false ]; then
    log_step "4/5" "部署服务 (./deploy.sh)"
    if ! run "cd \"${PROJECT_DIR}\" && bash \"${DEPLOY_SCRIPT}\" 2>&1"; then
      echo "❌ 部署失败，终止流程。请检查 deploy.sh 日志。"
      exit 1
    fi
    log "部署完成 ✓"
  else
    log_step "4/5" "⏭️  跳过部署 (--skip-deploy)"
  fi

  # Step 5: Git 归档
  log_step "5/5" "Git 归档 (add + commit + push)"

  # 检查是否有变更需要提交
  local has_changes
  has_changes="$(cd "${PROJECT_DIR}" && git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')"
  if [ "${has_changes}" -eq 0 ]; then
    log "没有文件变更，跳过 Git 归档"
  else
    # 生成或使用提供的 commit message
    local msg="${COMMIT_MESSAGE:-$(generate_commit_message)}"

    echo "  Commit message: ${msg}"
    echo "  变更文件 (${has_changes}):"
    cd "${PROJECT_DIR}" && git status --short | grep -v '^??' | sed 's/^/    /'

    echo ""

    # git add
    log "执行 git add -A ..."
    run "cd \"${PROJECT_DIR}\" && git add -A"

    # git commit
    log "执行 git commit ..."
    if ! run "cd \"${PROJECT_DIR}\" && git commit -m \"${msg}\" 2>&1"; then
      echo "⚠️  git commit 失败（可能没有变更需要提交），继续..."
    else
      log "提交成功 ✓"
    fi

    # git push
    log "执行 git push ..."
    if ! run "cd \"${PROJECT_DIR}\" && git push 2>&1"; then
      echo "⚠️  git push 失败，请检查网络或远程仓库权限。"
      echo "  本地提交已保留，稍后可手动推送。"
    else
      log "推送成功 ✓"
    fi
  fi

  # ============================================================
  # 完成
  # ============================================================
  echo ""
  echo "╔════════════════════════════════════════════════╗"
  echo "║   ✅ iReader 自动部署 & Git 归档 完成！       ║"
  echo "╚════════════════════════════════════════════════╝"

  if "${SKIP_DEPLOY}"; then
    echo "  📦 部署: ⏭️  已跳过"
  else
    echo "  📦 部署: ✅ 已完成"
  fi
  echo "  🏷️  Commit: ${msg:-$(generate_commit_message)}"
  echo ""
  echo "  服务地址: http://localhost:10000"
  echo "  项目目录: ${PROJECT_DIR}"
  echo ""
}

main "$@"
