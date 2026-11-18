#!/usr/bin/python3
"""User-operated SSH setup: key never appears in argv, shell history or stdout."""
import getpass, json, os, pathlib, urllib.request
if os.geteuid()!=0: raise SystemExit('请使用 sudo 运行。')
key=getpass.getpass('DeepSeek API Key（隐藏输入，不会显示字符）: ').strip()
if not key or '\n' in key: raise SystemExit('Key 为空或格式无效，未保存。')
try:
    req=urllib.request.Request('https://api.deepseek.com/models',headers={'Authorization':'Bearer '+key})
    with urllib.request.urlopen(req,timeout=20) as r: models=[x['id'] for x in json.load(r)['data']]
except Exception: raise SystemExit('无法通过官方 models 接口验证 Key/网络，未保存；没有回显秘密。')
print('账号实际可用模型：')
for i,m in enumerate(models,1): print(str(i)+'. '+m)
try: choice=int(input('选择用于阿维路由的模型序号: ')); model=models[choice-1] if 1<=choice<=len(models) else None
except Exception: model=None
if not model or not all(c.isalnum() or c in '-_.' for c in model): raise SystemExit('选择无效，未保存。')
d=pathlib.Path('/etc/awei-wechat');d.mkdir(mode=0o700,exist_ok=True)
for name,value in [('deepseek.key',key+'\n'),('service.env','AGY_MODEL_ID=claude-opus-4-6-thinking\nDEEPSEEK_MODEL='+model+'\n')]:
    tmp=d/(name+'.new');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f: f.write(value);f.flush();os.fsync(f.fileno())
    os.chmod(tmp,0o600);os.replace(tmp,d/name)
print('Key 已保存，官方 models 验证成功。模型：'+model+'。没有自动启动或重启服务。')
