#!/usr/bin/env python3
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
items=[]
for file in sorted(root.rglob('*')):
 rel=file.relative_to(root).as_posix()
 if rel=='manifest.json' or rel.startswith('.state/') or rel=='settings.env' or rel=='app/.env' or rel.startswith('app/.runtime/integrations/') or rel.startswith('app/.runtime/asin-amazon-session/'):continue
 if file.is_symlink():
  if not file.resolve().is_relative_to(root):raise SystemExit('External symlink: '+str(file))
  items.append({'path':rel,'link':str(file.readlink())})
 elif file.is_file():
  h=hashlib.sha256()
  with file.open('rb') as f:
   for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
  items.append({'path':rel,'size':file.stat().st_size,'sha256':h.hexdigest()})
(root/'manifest.json').write_text(json.dumps({'name':root.name,'algorithm':'SHA-256','files':items},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(items),'bytes':sum(i.get('size',0) for i in items)}))
