#!/usr/bin/env bash
#
# iReader 自动触发部署脚本
# ==========================
# 独立后台进程执行部署（防自杀），适用于 Git hooks / GitHub Webhook / CI 调用。
#
# 用法:
#   ./scripts/triggered-deploy.sh              # 默认等待 60 秒后部署
#   ./scripts/triggered-deploy.sh 30           # 等待 30 秒后部署
#   ./scripts/triggered-deploy.sh 0            # 立即部署（不等待）
#   ./scripts/triggered-deploy.sh --now        # 立即部署（同 0）
#   ./scripts/triggered-deploy.sh --help       # 显示帮助
#
# 流程:
#   1. git pull（拉取最新代码）
#   2. npm run typecheck（类型检查）
#   3. npm run build（构建）
#   4. npm test（测试）
#   5. bash deploy.sh（部署到 ~/.ireader）
#
# 设计要点:
#   - 独立后台进程（nohup + disown），父进程退出不影响执行
#   - 可配置延迟（默认 60 秒），给 git push 留出时间
#   - 日志自动归档到 logs/triggered-deploy/
#   - 幂等安全：多次触发不会冲突（每次生成独立日志）
#
set -euo pipefail

# ============================================================
# 默认配置
# ============================================================
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="${PROJECT_DIR}/deploy.sh"
DELAY_SECONDS=10
LOG_DIR="${PROJECT_DIR}/logs/triggered-deploy"
SELF_PID=$$

# ============================================================
# 帮助信息
# ============================================================
show_help() {
  cat <<'HELP'
iReader 自动触发部署脚本

用法:
  ./scripts/triggered-deploy.sh [delay] [options]

参数:
  delay             部署前等待秒数，默认 60。传 0 或 --now 则立即部署
  --help            显示此帮助

说明:
  以独立后台进程运行（nohup + disown），父进程退出不影响部署。
  日志写入: logs/triggered-deploy/yyyy-mm-dd_HHMMSS_PID.log

流程:
  1. git pull           拉取最新代码
  2. npm run typecheck  类型检查
  3. npm run build      构建项目
  4. npm test           运行测试
  5. bash deploy.sh     部署到生产环境
HELP
  exit 0
}

# ============================================================
# 参数解析
# ============================================================
parse_args() {
  for arg in "$@"; do
    case "${arg}" in
      --help)
        show_help
        ;;
      --now)
        DELAY_SECONDS=0
        ;;
      [0-9]*)
        DELAY_SECONDS="${arg}"
        ;;
      *)
        echo "错误: 未知参数 '${arg}'。使用 --help 查看帮助。"
        exit 1
        ;;
    esac
  done
}

parse_args "$@"

# ============================================================
# 日志函数
# ============================================================
LOG_FILE=""
init_log() {
  mkdir -p "${LOG_DIR}"
  local timestamp
  timestamp="$(date '+%Y-%m-%d_%H%M%S')"
  LOG_FILE="${LOG_DIR}/${timestamp}_${SELF_PID}.log"
  touch "${LOG_FILE}"
}

log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[${ts}] $*" | tee -a "${LOG_FILE}"
}

log_separator() {
  echo "" >> "${LOG_FILE}"
  echo "────────────────────────────────────────────────────" | tee -a "${LOG_FILE}"
  echo "  $*" | tee -a "${LOG_FILE}"
  echo "────────────────────────────────────────────────────" >> "${LOG_FILE}"
}

# ============================================================
# 运行检查
# ============================================================
run_step() {
  local step_name="$1"
  shift
  log_separator "🚀 ${step_name}"
  log "命令: $*"

  if eval "$@" >> "${LOG_FILE}" 2>&1; then
    log "✅ ${step_name} 通过"
    return 0
  else
    local exit_code=$?
    log "❌ ${step_name} 失败 (exit=${exit_code})"
    return "${exit_code}"
  fi
}

# ============================================================
# 部署主流程
# ============================================================
do_deploy() {
  log_separator "📚 iReader 自动触发部署 - $(date '+%Y-%m-%d %H:%M:%S')"
  log "项目目录: ${PROJECT_DIR}"
  log "日志文件: ${LOG_FILE}"
  log "延迟等待: ${DELAY_SECONDS} 秒"

  # ── 延迟等待（独立进程计数，不受父进程影响） ──
  if [ "${DELAY_SECONDS}" -gt 0 ]; then
    log "⏳ 等待 ${DELAY_SECONDS} 秒后开始部署..."
    sleep "${DELAY_SECONDS}"
    log "⏰ 等待结束，开始部署"
  fi

  cd "${PROJECT_DIR}"

  # ── Step 0: 前置检查 ──
  log_separator "🔍 前置检查"
  if ! command -v node &>/dev/null; then
    log "❌ 未找到 node 命令"
    return 1
  fi
  if ! command -v npm &>/dev/null; then
    log "❌ 未找到 npm 命令"
    return 1
  fi
  if ! command -v git &>/dev/null; then
    log "❌ 未找到 git 命令"
    return 1
  fi
  log "node $(node --version) ✓"
  log "npm $(npm --version) ✓"
  log "git $(git --version) ✓"

  # ── Step 1: git pull ──
  if ! run_step "Step 1/5: git pull" "git pull 2>&1"; then
    log "⚠️  git pull 失败，尝试继续（可能无远程更新或无网络）"
  fi

  # ── Step 2: 类型检查 ──
  if ! run_step "Step 2/5: 类型检查" "npm run typecheck 2>&1"; then
    log "❌ 类型检查失败，终止部署"
    return 1
  fi

  # ── Step 3: 构建 ──
  if ! run_step "Step 3/5: 构建项目" "npm run build 2>&1"; then
    log "❌ 构建失败，终止部署"
    return 1
  fi

  # ── Step 4: 测试 ──
  if ! run_step "Step 4/5: 运行测试" "npm test 2>&1"; then
    log "❌ 测试失败，终止部署"
    return 1
  fi

  # ── Step 5: 部署 ──
  if ! run_step "Step 5/5: 部署服务" "bash \"${DEPLOY_SCRIPT}\" 2>&1"; then
    log "❌ 部署失败"
    return 1
  fi

  # ── 健康检查 ──
  log_separator "🔍 健康检查"
  sleep 3
  if curl -s http://localhost:10000/api/health 2>/dev/null | grep -q '"ok"\|"status":"ok"\|"success":true'; then
    log "✅ 健康检查通过 — 服务正常运行 ✓"
  else
    log "⚠️  健康检查未通过，请检查服务状态"
    log "   sudo systemctl status ireader"
    log "   sudo journalctl -u ireader -n 50"
  fi

  # ── 完成 ──
  log_separator "✅ 自动触发部署完成"
  log "完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
  log "部署目录: ${HOME}/.ireader"
  log "服务地址: http://localhost:10000"
  echo ""
  echo "📋 完整日志: ${LOG_FILE}"
}

# ============================================================
# 作为独立后台进程执行
# ============================================================
run_as_background() {
  init_log

  # 重定向 stdout/stderr 到日志文件
  exec > "${LOG_FILE}" 2>&1

  # 运行部署
  do_deploy
  local exit_code=$?

  # 如果部署失败，追加错误摘要
  if [ "${exit_code}" -ne 0 ]; then
    echo ""
    echo "========================================"
    echo " ❌ 自动触发部署失败 (exit=${exit_code})"
    echo " 查看详细日志: ${LOG_FILE}"
    tail -20 "${LOG_FILE}"
    echo "========================================"
  fi

  exit "${exit_code}"
}

# ============================================================
# 前台运行（用于调试/测试）
# ============================================================
run_as_foreground() {
  init_log
  log "🔵 前台模式 — 日志同步输出到终端和文件"
  do_deploy
}

# ============================================================
# 入口
# ============================================================
main() {
  # 检查是否被 detach（后台模式）
  # 如果没有 nohup 标记且不是直接调用，自动后台化
  if [ -t 0 ]; then
    # 有终端 → 前台调用 → 自动转入后台执行
    echo "📚 iReader 自动触发部署"
    echo "  延迟: ${DELAY_SECONDS}s"
    echo ""
    echo "🔄 转入后台执行（独立进程，防自杀）..."
    echo "  日志: ${LOG_DIR}/"

    # 使用 nohup 启动后台进程
    nohup bash "$0" --internal-background "${DELAY_SECONDS}" > /dev/null 2>&1 &
    local bg_pid=$!

    # 解除父子关系（防自杀）
    disown "${bg_pid}" 2>/dev/null || true

    echo "  PID: ${bg_pid} ✓"
    echo ""
    echo "部署将在 ${DELAY_SECONDS} 秒后自动开始"
    echo "查看实时日志: tail -f ${LOG_DIR}/$(date '+%Y-%m-%d_')*"
    exit 0
  else
    # 无终端 → 后台执行
    run_as_background
  fi
}

# ── 内部参数：后台模式入口 ──
if [ "${1:-}" = "--internal-background" ]; then
  DELAY_SECONDS="${2:-60}"
  run_as_background
fi

main "$@"
