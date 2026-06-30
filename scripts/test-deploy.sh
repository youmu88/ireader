#!/usr/bin/env bash
#
# iReader deploy.sh Smoke Test
# =============================
# 在临时目录中测试 deploy.sh 的各项功能，不操作真实 ~/.ireader/。
# 测试完成后自动清理临时目录。
#
set -euo pipefail

PASS=0
FAIL=0
ALL_TESTS=()

TEST_DIR=""
DEPLOY_DIR=""

cleanup() {
  if [ -n "${TEST_DIR:-}" ] && [ -d "${TEST_DIR}" ]; then
    echo ""
    echo "🧹 清理临时目录: ${TEST_DIR}"
    rm -rf "${TEST_DIR}"
  fi
}

trap cleanup EXIT

# =============================================
# 断言辅助函数
# =============================================
assert() {
  local desc="$1"
  local result="$2"
  if [ "${result}" -eq 0 ]; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc}"
  fi
}

assert_file_exists() {
  local desc="$1"
  local file="$2"
  if [ -f "${file}" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc} (文件不存在: ${file})"
  fi
}

assert_dir_exists() {
  local desc="$1"
  local dir="$2"
  if [ -d "${dir}" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc} (目录不存在: ${dir})"
  fi
}

assert_not_dir_exists() {
assert_not_file_exists() {
  local desc="$1"
  local file="$2"
  if [ ! -f "${file}" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc} (文件不应存在: ${file})"
  fi
}


  local desc="$1"
  local dir="$2"
  if [ ! -d "${dir}" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc} (目录不应存在: ${dir})"
  fi
}

assert_contains() {
  local desc="$1"
  local file="$2"
  local pattern="$3"
  if grep -q "${pattern}" "${file}" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc} (文件 ${file} 不包含: ${pattern})"
  fi
}

assert_exit_code() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [ "${actual}" -eq "${expected}" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ ${desc} (期望退出码 ${expected}，实际 ${actual})"
  fi
}

# =============================================
# 取项目根目录
# =============================================
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="${PROJECT_DIR}/deploy.sh"

echo ""
echo "=============================================="
echo " iReader deploy.sh Smoke Test"
echo "=============================================="
echo " 项目目录: ${PROJECT_DIR}"
echo " 脚本路径: ${DEPLOY_SCRIPT}"
echo "=============================================="
echo ""

# =============================================
# Test 1: --help
# =============================================
echo "--- Test 1: --help ---"
"${DEPLOY_SCRIPT}" --help 2>&1 | head -5
assert "帮助信息正常输出" $?

echo ""

# =============================================
# Test 2: 非法参数
# =============================================
echo "--- Test 2: 非法参数 ---"
set +e
"${DEPLOY_SCRIPT}" --unknown-arg 2>&1
EXIT_CODE=$?
set -e
assert_exit_code "非法参数退出码为 1" 1 "${EXIT_CODE}"

echo ""

# =============================================
# Test 3: 默认部署到临时目录
# =============================================
echo "--- Test 3: 部署到临时目录 ---"
TEST_DIR="$(mktemp -d /tmp/ireader-deploy-test.XXXXXX)"
DEPLOY_DIR="${TEST_DIR}/ireader"

set +e
"${DEPLOY_SCRIPT}" --dir "${DEPLOY_DIR}" --port 19876 2>&1
EXIT_CODE=$?
set -e
assert_exit_code "部署脚本执行成功" 0 "${EXIT_CODE}"

echo ""

# =============================================
# Test 4: 验证目录结构
# =============================================
echo "--- Test 4: 验证目录结构 ---"
assert_dir_exists "app 目录存在" "${DEPLOY_DIR}/app"
assert_dir_exists "data 目录存在" "${DEPLOY_DIR}/data"
assert_dir_exists "logs 目录存在" "${DEPLOY_DIR}/logs"
assert_dir_exists "run 目录存在" "${DEPLOY_DIR}/run"
assert_dir_exists "app/backend/dist" "${DEPLOY_DIR}/app/backend/dist"
assert_dir_exists "app/frontend/dist" "${DEPLOY_DIR}/app/frontend/dist"
assert_file_exists "backend dist/index.js" "${DEPLOY_DIR}/app/backend/dist/index.js"
assert_file_exists "frontend dist/index.html" "${DEPLOY_DIR}/app/frontend/dist/index.html"
assert_file_exists ".env 配置文件" "${DEPLOY_DIR}/app/.env"
assert_file_exists "start.sh 启动脚本" "${DEPLOY_DIR}/app/start.sh"
assert_dir_exists "backend/node_modules" "${DEPLOY_DIR}/app/backend/node_modules"

echo ""

# =============================================
# Test 5: 验证 .env 配置
# =============================================
echo "--- Test 5: 验证环境配置 ---"
assert_contains "PORT 配置正确" "${DEPLOY_DIR}/app/.env" "PORT=19876"
assert_contains "DATA_DIR 配置正确" "${DEPLOY_DIR}/app/.env" "DATA_DIR=${DEPLOY_DIR}/data"

echo ""

# =============================================
# Test 6: 验证服务启动和健康检查
# =============================================
echo "--- Test 6: 验证服务启动 ---"
# 等待服务启动
echo "  等待服务就绪..."
sleep 3

# 检查 PID 文件
assert_file_exists "PID 文件存在" "${DEPLOY_DIR}/run/ireader.pid"

# 检查进程
if [ -f "${DEPLOY_DIR}/run/ireader.pid" ]; then
  PID=$(cat "${DEPLOY_DIR}/run/ireader.pid")
  if kill -0 "${PID}" 2>/dev/null; then
    assert "服务进程运行中 (PID: ${PID})" 0
  else
    assert "服务进程运行中" 1
  fi
fi

# 健康检查
set +e
HEALTH=$(curl -s http://127.0.0.1:19876/api/health 2>&1)
HEALTH_EXIT=$?
set -e
echo "  健康检查响应: ${HEALTH}"

if echo "${HEALTH}" | grep -q '"ok"\|"status":"ok"\|"success":true'; then
  assert "健康检查通过" 0
else
  assert "健康检查通过" 1
  echo "  ⚠️  响应内容: ${HEALTH}"
  echo "  日志:"
  tail -10 "${DEPLOY_DIR}/logs/app.log" 2>/dev/null || echo "  (无日志)"
fi

echo ""

# =============================================
# Test 7: 验证应用日志
# =============================================
echo "--- Test 7: 验证日志 ---"
assert_file_exists "app 日志存在" "${DEPLOY_DIR}/logs/app.log"
assert_file_exists "deploy 日志存在" "${DEPLOY_DIR}/logs/deploy.log"
assert_contains "部署日志包含端口信息" "${DEPLOY_DIR}/logs/deploy.log" "19876"
assert_contains "部署日志包含部署目录" "${DEPLOY_DIR}/logs/deploy.log" "${DEPLOY_DIR}"

echo ""

# =============================================
# Test 8: 停止服务并测试 --clean
# =============================================
echo "--- Test 8: --clean 清理 ---"
# 先停止旧服务（避免端口占用）
if [ -f "${DEPLOY_DIR}/run/ireader.pid" ]; then
  OLD_PID=$(cat "${DEPLOY_DIR}/run/ireader.pid")
  kill "${OLD_PID}" 2>/dev/null || true
  sleep 1
fi

set +e
"${DEPLOY_SCRIPT}" --dir "${DEPLOY_DIR}" --clean 2>&1
EXIT_CODE=$?
set -e
assert_exit_code "清理脚本执行成功" 0 "${EXIT_CODE}"

# 验证 app 被清理（目录存在但内容清空），data 保留
assert_dir_exists "app 目录结构保留" "${DEPLOY_DIR}/app"
assert_dir_exists "data 目录保留" "${DEPLOY_DIR}/data"
# app 内容应被清空（无 backend、frontend 等子目录）
assert_not_dir_exists "app 下 backend 已清理" "${DEPLOY_DIR}/app/backend"
assert_not_dir_exists "app 下 frontend 已清理" "${DEPLOY_DIR}/app/frontend"
assert_not_file_exists "app 下 start.sh 已清理" "${DEPLOY_DIR}/app/start.sh"
assert_dir_exists "logs 目录保留（含日志轮转）" "${DEPLOY_DIR}/logs"

echo ""

# =============================================
# Test 9: 验证 --reset-data 二次确认取消
# =============================================
echo "--- Test 9: --reset-data 取消 ---"
echo "  输入 'no' 应取消..."
set +e
echo "no" | "${DEPLOY_SCRIPT}" --dir "${DEPLOY_DIR}" --reset-data 2>&1
EXIT_CODE=$?
set -e
assert_exit_code "取消操作退出码为 0" 0 "${EXIT_CODE}"

# data 目录应仍存在
assert_dir_exists "data 目录未被删除" "${DEPLOY_DIR}/data"

echo ""

# =============================================
# Test 10: 验证构建产物完整性
# =============================================
echo "--- Test 10: 增量部署到原目录 ---"
set +e
"${DEPLOY_SCRIPT}" --dir "${DEPLOY_DIR}" --port 19876 --incremental-build 2>&1
EXIT_CODE=$?
set -e
assert_exit_code "增量部署脚本执行成功" 0 "${EXIT_CODE}"

# 停止服务
if [ -f "${DEPLOY_DIR}/run/ireader.pid" ]; then
  kill "$(cat "${DEPLOY_DIR}/run/ireader.pid")" 2>/dev/null || true
  sleep 1
fi

echo ""

# =============================================
# 汇总
# =============================================
echo "=============================================="
echo " 测试结果汇总"
echo "=============================================="
echo "  通过: ${PASS}/${PASS}/${FAIL}"
echo "  失败: ${FAIL}"
echo "  总计: $((PASS + FAIL))"
echo "=============================================="

if [ "${FAIL}" -eq 0 ]; then
  echo ""
  echo "🎉 所有测试通过！"
  echo ""
  exit 0
else
  echo ""
  echo "❌ ${FAIL} 个测试失败"
  echo ""
  exit 1
fi
