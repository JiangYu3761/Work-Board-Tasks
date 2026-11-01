#!/bin/zsh
set -e
cd "${0:A:h}"
if /usr/bin/curl --silent --fail --max-time 2 http://127.0.0.1:4317/api/health >/dev/null; then
  /usr/bin/open http://127.0.0.1:4317
  exit 0
fi
task_node="$(command -v node || true)"
if [[ -z "$task_node" ]]; then task_node="$HOME/.local/bin/node"; fi
if [[ ! -x "$task_node" ]]; then
  print '未找到 Node.js。请安装 Node.js 22 或以上版本。'
  read -k 1
  exit 1
fi
print '北向即将启动。打开 http://127.0.0.1:4317 查看网站。'
print '请保持此窗口运行；按 Control+C 停止服务。'
exec "$task_node" --env-file-if-exists=.env server.mjs
