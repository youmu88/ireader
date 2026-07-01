#!/usr/bin/env bash
#
# iReader 一键部署脚本
# ====================
# 部署 iReader 到指定目录，默认 ~/.ireader/，默认端口 10000。
#
# 用法:
#   ./deploy.sh                          # 默认增量部署到 ~/.ireader，端口 10000
#   ./deploy.sh --dir /opt/ireader       # 自定义部署目录
#   ./deploy.sh --port 8080              # 自定义端口
#   ./deploy.sh --full-build             # 全量构建（清理依赖/产物后重装）
#   ./deploy.sh --clean                  # 清理旧实例（停止进程并清理 app 目录）
#   ./deploy.sh --reset-data             # ⚠️ 危险：清理数据库和图书（需二次确认）
#   ./deploy.sh --help                   # 显示帮助信息
#
set -euo pipefail

# ============================================================
# 默认配置
# ============================================================
DEPLOY_DIR="${HOME}/.ireader"
PORT=10000
BUILD_MODE="incremental"   # incremental | full
ACTION="deploy"            # deploy | clean | reset-data | help
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# ============================================================
# 帮助信息
# ============================================================
show_help() {
  cat <<'HELP'
iReader 一键部署脚本

用法:
  ./deploy.sh                          默认增量部署到 ~/.ireader，端口 10000
  ./deploy.sh --dir /opt/ireader       自定义部署目录
  ./deploy.sh --port 8080              自定义端口
  ./deploy.sh --dir /opt/ireader --port 18080  组合参数
  ./deploy.sh --full-build             全量构建后部署
  ./deploy.sh --incremental-build      增量构建（默认）
  ./deploy.sh --clean                  停止旧实例并清理 app 目录（保留 data）
  ./deploy.sh --reset-data             ⚠️  危险：清理全部数据（需二次确认）
  ./deploy.sh --help                   显示此帮助

参数说明:
  --dir <path>         部署目标目录（默认: ~/.ireader）
  --port <port>        服务端口（默认: 10000）
  --incremental-build  增量构建，复用 node_modules（默认）
  --full-build         全量构建，清理 node_modules/dist 后重新安装
  --clean              停止旧实例并清理 app 目录
  --reset-data         清理全部数据（包含数据库和图书文件）
  --help               显示此帮助
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

# ============================================================
# 参数解析
# ============================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      if [[ -z "${2:-}" ]]; then
        echo "错误: --dir 需要目录路径参数"
        exit 1
      fi
      DEPLOY_DIR="$2"
      shift 2
      ;;
    --port)
      if [[ -z "${2:-}" ]]; then
        echo "错误: --port 需要端口号参数"
        exit 1
      fi
      if ! [[ "$2" =~ ^[0-9]+$ ]] || [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
        echo "错误: 端口号必须是 1-65535 之间的整数"
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    --incremental-build)
      BUILD_MODE="incremental"
      shift
      ;;
    --full-build)
      BUILD_MODE="full"
      shift
      ;;
    --clean)
      ACTION="clean"
      shift
      ;;
    --reset-data)
      ACTION="reset-data"
      shift
      ;;
    --help)
      show_help
      ;;
    *)
      echo "错误: 未知参数 '$1'。使用 --help 查看帮助。"
      exit 1
      ;;
  esac
done

# ============================================================
# 路径定义
# ============================================================
APP_DIR="${DEPLOY_DIR}/app"
DATA_DIR="${DEPLOY_DIR}/data"
LOGS_DIR="${DEPLOY_DIR}/logs"
RUN_DIR="${DEPLOY_DIR}/run"
DEPLOY_LOG="${LOGS_DIR}/deploy.log"
PID_FILE="${RUN_DIR}/ireader.pid"
ENV_FILE="${APP_DIR}/.env"

# ============================================================
# 前置检查
# ============================================================
check_prerequisites() {
  # 检查 Node.js
  if ! command -v node &>/dev/null; then
    echo "错误: 未找到 node 命令。请先安装 Node.js (>=18)。"
    exit 1
  fi

  local node_version
  node_version="$(node --version | sed 's/^v//')"
  local node_major
  node_major="$(echo "${node_version}" | cut -d. -f1)"
  if [ "${node_major}" -lt 18 ]; then
    echo "错误: Node.js 版本过低 (v${node_version})，需要 v18+。"
    exit 1
  fi
  log "Node.js v${node_version} ✓"

  # 检查 npm
  if ! command -v npm &>/dev/null; then
    echo "错误: 未找到 npm 命令。"
    exit 1
  fi
  local npm_version
  npm_version="$(npm --version)"
  log "npm v${npm_version} ✓"

  # 检查源代码目录
  if [ ! -f "${SOURCE_DIR}/package.json" ]; then
    echo "错误: 未在源代码目录找到 package.json。请在 iReader 源码根目录执行 deploy.sh。"
    exit 1
  fi
  if [ ! -d "${SOURCE_DIR}/backend" ] || [ ! -d "${SOURCE_DIR}/frontend" ]; then
    echo "错误: 缺少 backend/ 或 frontend/ 目录。请在 iReader 源码根目录执行 deploy.sh。"
    exit 1
  fi
  log "源代码目录: ${SOURCE_DIR} ✓"
}

# ============================================================
# 创建目录结构
# ============================================================
create_directories() {
  mkdir -p "${APP_DIR}" "${DATA_DIR}" "${LOGS_DIR}" "${RUN_DIR}"
  log "目录结构已创建: ${DEPLOY_DIR}"
}

# ============================================================
# 查找并终止所有占用目标端口的进程（端口级清理，更彻底）
# ============================================================
kill_processes_on_port() {
  local port=$1

  if ! command -v lsof &>/dev/null; then
    log "lsof 不可用，跳过端口级进程清理"
    return
  fi

  local pids
  pids="$(lsof -ti \":${port}\" 2>/dev/null || true)"
  if [ -n "${pids}" ]; then
    log "发现端口 ${port} 被以下进程占用: $(echo "${pids}" | tr '\n' ' ')"
    for pid in ${pids}; do
      if [ "${pid}" = "$$" ] || [ "${pid}" = "${PPID:-}" ]; then
        continue
      fi
      log "  终止进程 (PID: ${pid})..."
      kill "${pid}" 2>/dev/null || true
    done
    sleep 2
    local remaining
    remaining="$(lsof -ti \":${port}\" 2>/dev/null || true)"
    if [ -n "${remaining}" ]; then
      log "部分进程未响应，强制终止: $(echo "${remaining}" | tr '\n' ' ')"
      for pid in ${remaining}; do
        kill -9 "${pid}" 2>/dev/null || true
      done
      sleep 1
    fi
    log "端口 ${port} 已释放"
  else
    log "端口 ${port} 未被占用"
  fi
}


# ============================================================
# 停止旧实例
# ============================================================
stop_old_instance() {
  # 方式1: 基于端口的进程清理（可发现 PID 文件未追踪的残留进程）
  kill_processes_on_port "${PORT}"

  # 方式2: 基于 PID 文件的进程清理（向后兼容）
  if [ -f "${PID_FILE}" ]; then
    local old_pid
    old_pid="$(cat "${PID_FILE}")"
    if kill -0 "${old_pid}" 2>/dev/null; then
      log "停止旧实例 (PID: ${old_pid})..."
      kill "${old_pid}" 2>/dev/null || true
      # 等待进程退出，最多 10 秒
      local wait_count=0
      while kill -0 "${old_pid}" 2>/dev/null; do
        sleep 1
        wait_count=$((wait_count + 1))
        if [ "${wait_count}" -ge 10 ]; then
          log "进程未响应，强制终止 (PID: ${old_pid})..."
          kill -9 "${old_pid}" 2>/dev/null || true
          break
        fi
      done
      log "旧实例已停止"
    else
      log "PID ${old_pid} 未运行，清理 PID 文件"
    fi
    rm -f "${PID_FILE}"
  else
    log "未发现运行中的旧实例（PID 文件）"
  fi
}

# ============================================================
# 构建
# ============================================================
do_build() {
  log "开始构建 (模式: ${BUILD_MODE})..."

  cd "${SOURCE_DIR}"

  if [ "${BUILD_MODE}" = "full" ]; then
    log "全量构建: 清理 node_modules 和 dist..."

    # 清理 backend
    if [ -d "backend/node_modules" ]; then
      rm -rf "backend/node_modules"
      log "  已清理 backend/node_modules"
    fi
    if [ -d "backend/dist" ]; then
      rm -rf "backend/dist"
      log "  已清理 backend/dist"
    fi

    # 清理 frontend
    if [ -d "frontend/node_modules" ]; then
      rm -rf "frontend/node_modules"
      log "  已清理 frontend/node_modules"
    fi
    if [ -d "frontend/dist" ]; then
      rm -rf "frontend/dist"
      log "  已清理 frontend/dist"
    fi

    # 清理根 node_modules
    if [ -d "node_modules" ]; then
      rm -rf "node_modules"
      log "  已清理根 node_modules"
    fi

    # 重新安装依赖
    log "安装根依赖..."
    npm install 2>&1 | while IFS= read -r line; do log "  npm: ${line}"; done

    log "安装 backend 依赖..."
    cd backend && npm install 2>&1 | while IFS= read -r line; do log "  npm: ${line}"; done
    cd ..

    log "安装 frontend 依赖..."
    cd frontend && npm install 2>&1 | while IFS= read -r line; do log "  npm: ${line}"; done
    cd ..
  else
    # 增量构建：确保 node_modules 存在，缺失才安装
    log "增量构建: 检查依赖..."

    cd "${SOURCE_DIR}"
    if [ ! -d "node_modules" ]; then
      log "安装根依赖..."
      npm install 2>&1 | tail -3
    fi
    if [ ! -d "backend/node_modules" ]; then
      log "安装 backend 依赖..."
      cd backend && npm install 2>&1 | tail -3
      cd ..
    fi
    if [ ! -d "frontend/node_modules" ]; then
      log "安装 frontend 依赖..."
      cd frontend && npm install 2>&1 | tail -3
      cd ..
    fi
  fi

  # 执行构建
  cd "${SOURCE_DIR}"
  log "执行构建: backend..."
  cd backend && npm run build 2>&1 | while IFS= read -r line; do log "  backend: ${line}"; done
  cd ..

  log "执行构建: frontend..."
  cd frontend && npm run build 2>&1 | while IFS= read -r line; do log "  frontend: ${line}"; done
  cd ..

  log "构建完成 ✓"
}

# ============================================================
# 部署（拷贝构建产物到目标目录）
# ============================================================
do_deploy() {
  log "部署到: ${APP_DIR}"

  # 清理旧 app 内容（保留 .env）
  if [ -d "${APP_DIR}" ]; then
    log "清理旧 app 目录..."
    # 保留 .env 和 node_modules（节省重新安装时间）
    local has_env=false
    local has_nm=false
    [ -f "${ENV_FILE}" ] && has_env=true
    [ -d "${APP_DIR}/backend/node_modules" ] && has_nm=true

    rm -rf "${APP_DIR:?}/"*

    if $has_env; then
      log "  保留已有 .env 配置"
    fi
    if $has_nm; then
      log "  注意: node_modules 已被清理，需在启动时重新安装或拷贝"
    fi
  fi

  # 拷贝 backend 构建产物
  log "拷贝 backend..."
  mkdir -p "${APP_DIR}/backend"
  cp -r "${SOURCE_DIR}/backend/package.json" "${APP_DIR}/backend/"

  # 拷贝 dist
  if [ -d "${SOURCE_DIR}/backend/dist" ]; then
    cp -r "${SOURCE_DIR}/backend/dist" "${APP_DIR}/backend/"
    log "  → dist/ (${SOURCE_DIR}/backend/dist)"
  else
    echo "错误: backend/dist 不存在，构建可能失败。"
    exit 1
  fi

  # 安装 backend 生产依赖
  log "安装 backend 生产依赖..."
  cd "${APP_DIR}/backend" && npm install --production 2>&1 | while IFS= read -r line; do log "  npm: ${line}"; done
  cd "${SOURCE_DIR}"

  # 拷贝 frontend 构建产物
  log "拷贝 frontend..."
  mkdir -p "${APP_DIR}/frontend"
  if [ -d "${SOURCE_DIR}/frontend/dist" ]; then
    cp -r "${SOURCE_DIR}/frontend/dist" "${APP_DIR}/frontend/"
    log "  → dist/ (${SOURCE_DIR}/frontend/dist)"
  else
    echo "错误: frontend/dist 不存在，构建可能失败。"
    exit 1
  fi

  # 拷贝根 package.json（用于启动脚本识别项目）
  cp "${SOURCE_DIR}/package.json" "${APP_DIR}/"

  # 写入/更新环境配置
  log "写入环境配置..."
  cat > "${ENV_FILE}" <<ENVEOF
# iReader Production Configuration
PORT=${PORT}
DATA_DIR=${DATA_DIR}
ENVEOF

  log "部署完成 ✓"
}

# ============================================================
# 启动服务
# ============================================================
start_service() {
  log "启动 iReader 服务 (端口: ${PORT})..."

  # 写入启动脚本
  cat > "${APP_DIR}/start.sh" <<'STARTEOF'
#!/usr/bin/env bash
set -euo pipefail

# 加载环境变量
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

export PORT="${PORT:-10000}"
export DATA_DIR="${DATA_DIR:-${HOME}/.ireader/data}"

# 启动服务
cd "${SCRIPT_DIR}/backend"
exec node dist/index.js
STARTEOF
  chmod +x "${APP_DIR}/start.sh"

  # 启动服务（后台运行）
  nohup "${APP_DIR}/start.sh" > "${LOGS_DIR}/app.log" 2>&1 &
  local new_pid=$!
  echo "${new_pid}" > "${PID_FILE}"
  log "服务已启动 (PID: ${new_pid})"

  # 等待服务就绪
  sleep 2

  # 健康检查
  local max_retries=12
  local retry=0
  while [ "${retry}" -lt "${max_retries}" ]; do
    if curl -s "http://127.0.0.1:${PORT}/api/health" | grep -q '"ok"\|"status":"ok"\|"success":true' 2>/dev/null; then
      log "健康检查通过 ✓"
      return 0
    fi
    retry=$((retry + 1))
    sleep 2
  done

  # 健康检查失败
  log "⚠️  健康检查未通过，请检查日志: ${LOGS_DIR}/app.log"
  tail -20 "${LOGS_DIR}/app.log"
  return 1
}

# ============================================================
# 清理（保留 data）
# ============================================================
do_clean() {
  log "执行清理 (--clean)..."

  # 停止旧实例
  stop_old_instance

  # 清理 app 目录
  if [ -d "${APP_DIR}" ]; then
    rm -rf "${APP_DIR:?}/"*
    log "app 目录已清理: ${APP_DIR}"
  fi

  # 清理日志（保留 3 份最近的日志）
  if [ -f "${LOGS_DIR}/app.log" ]; then
    cp "${LOGS_DIR}/app.log" "${LOGS_DIR}/app.log.1" 2>/dev/null || true
    > "${LOGS_DIR}/app.log"
    log "app 日志已轮转"
  fi

  log "清理完成 ✓"
  log "说明: data 目录 (${DATA_DIR}) 中的数据库和图书文件已保留"
}

# ============================================================
# 重置数据（危险操作）
# ============================================================
do_reset_data() {
  echo ""
  echo "⚠️ ⚠️ ⚠️  危险操作  ⚠️ ⚠️ ⚠️ "
  echo "您即将删除 iReader 全部数据，包括："
  echo "  - SQLite 数据库（阅读进度、图书元数据、设置）"
  echo "  - 上传的图书文件"
  echo "  - TTS 缓存"
  echo "  - 封面缓存"
  echo ""
  echo -n "请输入 YES 确认继续: "
  read -r confirm
  if [ "${confirm}" != "YES" ]; then
    echo "操作已取消。"
    exit 0
  fi

  # 停止旧实例
  stop_old_instance

  if [ -d "${DATA_DIR}" ]; then
    rm -rf "${DATA_DIR:?}/"*
    log "数据目录已清空: ${DATA_DIR}"
  fi

  # 清理 app
  if [ -d "${APP_DIR}" ]; then
    rm -rf "${APP_DIR:?}/"*
    log "app 目录已清空: ${APP_DIR}"
  fi

  log "数据重置完成 ✓"
}

# ============================================================
# 主流程
# ============================================================
init_deploy_log() {
  # 确保日志目录存在
  mkdir -p "${LOGS_DIR}"
  {
    echo ""
    echo "=========================================="
    echo " iReader Deploy - $(date)"
    echo "=========================================="
    echo " Source:   ${SOURCE_DIR}"
    echo " Target:   ${DEPLOY_DIR}"
    echo " Port:     ${PORT}"
    echo " Mode:     ${BUILD_MODE}"
    echo " Action:   ${ACTION}"
    echo "=========================================="
  } >> "${DEPLOY_LOG}" 2>/dev/null || true
}

main() {
  # 保存标准输出（用于后续日志覆盖）
  exec 3>&1

  case "${ACTION}" in
    help)
      show_help
      ;;
    clean)
      check_prerequisites
      do_clean
      log "部署清理完成。可使用 ./deploy.sh 重新部署。"
      echo ""
      echo "📚 iReader 已清理完成。"
      ;;
    reset-data)
      do_reset_data
      echo ""
      echo "📚 iReader 数据已重置。"
      ;;
    deploy)
      check_prerequisites
      create_directories
      init_deploy_log
      stop_old_instance
      do_build
      do_deploy
      create_directories  # 重新创建（clean deploy 中可能被删）
      start_service

      local exit_code=$?
      if [ "${exit_code}" -eq 0 ]; then
        echo ""
        echo "=========================================="
        echo " ✅ iReader 部署成功！"
        echo "=========================================="
        echo " 访问地址:  http://localhost:${PORT}"
        echo " 部署目录:  ${DEPLOY_DIR}"
        echo " 数据目录:  ${DATA_DIR}"
        echo " 日志文件:  ${LOGS_DIR}/app.log"
        echo " PID 文件:  ${PID_FILE}"
        echo "------------------------------------------"
        echo " 管理命令:"
        echo "  停止服务:  kill \$(cat ${PID_FILE})"
        echo "  重新部署:  cd ${SOURCE_DIR} && ./deploy.sh"
        echo "  清理部署:  cd ${SOURCE_DIR} && ./deploy.sh --clean"
        echo "=========================================="
      else
        echo ""
        echo "❌ iReader 部署可能未完全成功。请检查日志:"
        echo "   ${LOGS_DIR}/app.log"
        echo "   ${DEPLOY_LOG}"
      fi

      # 记录部署结果到日志
      {
        echo " Exit:     ${exit_code}"
        echo "=========================================="
        echo ""
      } >> "${DEPLOY_LOG}" 2>/dev/null || true

      exit "${exit_code}"
      ;;
  esac
}

main "$@"
