#!/bin/zsh
set -eu
cd "${0:A:h}"
if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  print '请在 Mac 上运行此安装器。'
  exit 1
fi
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
task_node="$(command -v node || true)"
if [[ -z "$task_node" ]]; then
  task_nodes=("$HOME"/.nvm/versions/node/*/bin/node(Nn))
  if (( ${#task_nodes} )); then task_node="${task_nodes[-1]}"; fi
fi
if [[ -z "$task_node" || ! -x "$task_node" ]]; then
  print '未找到 Node.js。请安装 Node.js 22 或以上版本后重试。'
  read -k 1 '?按任意键关闭。'
  exit 1
fi
if ! "$task_node" scripts/desktop/install.mjs --project "$PWD"; then
  print '请按上面的提示处理后，再双击此安装器。'
  read -k 1 '?按任意键关闭。'
  exit 1
fi
