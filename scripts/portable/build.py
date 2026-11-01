#!/usr/bin/env python3
"""Build a self-contained, private Apple-silicon transfer copy from this project."""
import hashlib, json, os, shutil, stat, sys
from pathlib import Path
from datetime import datetime, timezone

project = Path(__file__).resolve().parents[2]
dest = Path(sys.argv[1]).resolve()
if dest.exists():
    raise SystemExit('Refusing to overwrite an existing transfer package: ' + str(dest))
dest.mkdir(parents=True, mode=0o700)
app = dest / 'app'
app.mkdir()
excluded = {'.runtime', 'node_modules', 'work', '.env', '.DS_Store', '.git', '启动北向.command'}
for source in project.iterdir():
    if source.name in excluded: continue
    target = app / source.name
    if source.is_dir(): shutil.copytree(source, target, symlinks=True, ignore=shutil.ignore_patterns('.DS_Store', '*.log'))
    else: shutil.copy2(source, target)
shutil.copytree(project/'node_modules', app/'node_modules', symlinks=True)
for rel in ['asin-evidence', 'search-monitor/runs', 'integrations']:
    source = project/'.runtime'/rel
    if source.exists(): shutil.copytree(source, app/'.runtime'/rel, symlinks=True)
(app/'.runtime/asin-amazon-session').mkdir(parents=True, mode=0o700)
(app/'.runtime/asin-amazon-session/session.json').write_text(json.dumps({'state':'needs_login','generation':None,'verified_at':None,'reason':'迁移后请在专用窗口重新登录并验证 Amazon 会话'}, ensure_ascii=False))
os.chmod(app/'.runtime/asin-amazon-session/session.json',0o600)
(dest/'runtime/node/bin').mkdir(parents=True)
shutil.copy2('/Users/jiangyu/.hermes/node/bin/node', dest/'runtime/node/bin/node')
shutil.copy2('/Users/jiangyu/.hermes/node/LICENSE', dest/'runtime/node/LICENSE')
shutil.copytree('/Applications/Postgres.app/Contents/Versions/18', dest/'runtime/postgres', symlinks=True)
(dest/'runtime/browsers').mkdir()
for name in ['chromium-1234', 'chromium_headless_shell-1234', 'ffmpeg-1011']:
    shutil.copytree(Path.home()/'Library/Caches/ms-playwright'/name,dest/'runtime/browsers'/name,symlinks=True)
(dest/'backup').mkdir()
for name in ['database.dump','database-inventory.json']:
    shutil.copy2(project/'work/portable-migration'/name,dest/'backup'/name)
(dest/'support').mkdir()
for name in ['manage.mjs','integrity.mjs']:
    shutil.copy2(project/'scripts/portable'/name,dest/'support'/name)
for name, action in [('启动北向.command','manage.mjs start'),('停止北向.command','manage.mjs stop'),('检查迁移包.command','integrity.mjs')]:
    script='''#!/bin/zsh
set -u
task_root="${0:A:h}"
cd "$task_root"
if [[ "$(/usr/bin/uname -m)" != arm64 ]]; then
  print '此离线包适用于 Apple 芯片 Mac。请使用匹配的 Windows / Intel 版本。'
  read -k 1
  exit 1
fi
"$task_root/runtime/node/bin/node" "$task_root/support/SCRIPT" ARGS
task_result=$?
if [[ $task_result -ne 0 ]]; then
  print '\n未完成。请保留上方错误信息，按任意键关闭。'
  read -k 1
fi
exit $task_result
'''
    file, _, args=action.partition(' ')
    script=script.replace('SCRIPT',file).replace(' ARGS',(' '+args) if args else '')
    (dest/name).write_text(script)
    os.chmod(dest/name,0o755)
(dest/'north').write_text('''#!/bin/zsh
task_root="${0:A:h}"
exec "$task_root/runtime/node/bin/node" "$task_root/app/bin/north.mjs" "$@"
''')
os.chmod(dest/'north',0o755)
settings=(project/'.env').read_text().splitlines()
managed=['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PORT','PLAYWRIGHT_BROWSERS_PATH','SEARCH_CHROMIUM_PATH','ASIN_CHROMIUM_PATH','NORTH_FEISHU_ENABLED']
settings=[s for s in settings if not any(s.startswith(k+'=') for k in managed)]
(dest/'settings.env').write_text('# 自定义设置；数据库与浏览器路径由启动器自动管理。\n'+'\n'.join(settings)+'\nNORTH_FEISHU_ENABLED=0\n')
os.chmod(dest/'settings.env',0o600)
metadata={'name':dest.name,'platform':'darwin-arm64','minimum_macos':'14','created_at':datetime.now(timezone.utc).isoformat(),'runtime':{'node':'22.22.3','postgresql':'18.4','playwright':'1.62.1','chromium_revision':'1234'},'owner_project':'北向 NORTH / 项目-个人网站','contains_private_data':True,'state_directory':'.state'}
(dest/'package-info.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'package':str(dest),'created':True},ensure_ascii=False))
