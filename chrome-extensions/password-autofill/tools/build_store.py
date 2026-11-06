"""生成 Chrome 商店精简包：只保留 Windchill 助手 + Fabriq AI 优化，去掉公司品牌名和其他站点功能。

用法：python tools/build_store.py [输出 zip 路径]
"""
import json, os, re, shutil, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = 'Work Assistant Toolkit'
DESCRIPTION = 'Windchill 智能检索、签名文件批量下载与规则库；Fabriq 工单 AI 优化与翻译。账号与记录只保存在本机。'

SKIP_DIRS = {'tests', 'docs', 'tools', '.git', 'node_modules'}
SKIP_FILES = {'dev-chrome.bat', 'dev-load.js', 'deploy-extension.bat', 'INSTALL.md', 'PROJECT_STRUCTURE.md',
              'USAGE_GUIDE.md', 'README.md', 'CHANGELOG.md'}
# 与商店版无关的站点功能：脚本、样式和图标
REMOVE_FILES = ['content.js', 'content_ehr_approve.js', 'content_workday.js', 'content_workday_req.js', 'content_pbi.js',
                'content_planner.js', 'content_planner_v2.js', 'styles_planner.css', 'dev_bridge.js', 'mwa_dock.js',
                'pending_sync.js', 'icons/cornerstone.png', 'icons/ehr.png', 'icons/workday.png', 'icons/powerbi.png',
                'icons/oee.png']
REMOVED_HOSTS = ('csod.com', 'ehr.', 'myworkday.com', 'powerbi.com', '127.0.0.1')


def build(out):
    tmp = tempfile.mkdtemp(prefix='mwa-store-')
    dst = os.path.join(tmp, 'pkg')
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            if f in SKIP_FILES or f.endswith(('.bak', '.orig', '.log')):
                continue
            src = os.path.join(dp, f)
            rel = os.path.relpath(src, ROOT)
            os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True)
            shutil.copy2(src, os.path.join(dst, rel))
    for rel in REMOVE_FILES:
        path = os.path.join(dst, rel)
        if os.path.exists(path):
            os.remove(path)

    # manifest
    path = os.path.join(dst, 'manifest.json')
    manifest = json.load(open(path, encoding='utf-8'))
    manifest['name'] = NAME
    manifest['description'] = DESCRIPTION
    manifest['action']['default_title'] = NAME
    manifest['host_permissions'] = [h for h in manifest['host_permissions']
                                    if not any(x in h for x in REMOVED_HOSTS) and 'api.gpt.' not in h]
    manifest['content_scripts'] = [c for c in manifest['content_scripts']
                                   if not any(any(x in m for x in REMOVED_HOSTS) for m in c['matches'])]
    manifest['web_accessible_resources'] = [w for w in manifest.get('web_accessible_resources', [])
                                            if not any(any(x in m for x in REMOVED_HOSTS) for m in w['matches'])]
    json.dump(manifest, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    # 文本：品牌名；已移除站点的域名替换成不可解析的占位（对应功能在商店版里不可达）
    for dp, _, fn in os.walk(dst):
        for f in fn:
            if not f.endswith(('.js', '.html', '.json')):
                continue
            p = os.path.join(dp, f)
            text = open(p, encoding='utf-8').read()
            new = (text.replace('Medtronic Work Assistant', NAME).replace('Medtronic Smart Assistant', NAME)
                   .replace('ehr.medtronic.com.cn', 'ehr.invalid').replace('medtronic.csod.com', 'csod.invalid'))
            if new != text:
                open(p, 'w', encoding='utf-8').write(new)

    # background：不再加载待办同步
    p = os.path.join(dst, 'background.js')
    text = open(p, encoding='utf-8').read().replace("importScripts('pending_sync.js', ", "importScripts(")
    open(p, 'w', encoding='utf-8').write(text)

    # popup：已移除站点的卡片强制隐藏；后台「功能管理」不再列出它们
    p = os.path.join(dst, 'popup.html')
    text = open(p, encoding='utf-8').read()
    hide = '    .app[data-feature=cornerstone], .app[data-feature=ehr], .app[data-feature=workday], .app[data-feature=powerbi], .app[data-feature=oee] { display: none !important; }\n'
    text = text.replace('    .app[hidden] { display: none; }\n', '    .app[hidden] { display: none; }\n' + hide)
    # 被隐藏卡片上残留的站点链接一并清掉
    text = re.sub(r'(data-feature="(?:cornerstone|ehr|workday|powerbi|oee)") data-url="[^"]*"', r'\1 data-url="about:blank"', text)
    open(p, 'w', encoding='utf-8').write(text)
    p = os.path.join(dst, 'options.html')
    text = open(p, encoding='utf-8').read().replace('https://api.gpt.medtronic.com/providers/openai/v1', 'https://api.example.com/v1')
    text = text.replace('Windchill 下载 / 自动点击、Fabriq 应用 AI 结果、EHR 审批与自动填充、Cornerstone、Workday 等',
                        'Windchill 下载与自动点击、Fabriq 应用 AI 结果等')
    open(p, 'w', encoding='utf-8').write(text)
    p = os.path.join(dst, 'options.js')
    text = open(p, encoding='utf-8').read()
    text = re.sub(r"\n\s*\['(?:oee|cornerstone|ehr|workday|powerbi)',[^\n]*\],?", '', text)
    open(p, 'w', encoding='utf-8').write(text)

    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for dp, _, fn in os.walk(dst):
            for f in fn:
                full = os.path.join(dp, f)
                z.write(full, os.path.relpath(full, dst).replace(os.sep, '/'))
    return dst


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', 'releases', 'WorkAssistantToolkit-store.zip')
    folder = build(os.path.abspath(target))
    print('built', os.path.abspath(target), 'staging:', folder)
