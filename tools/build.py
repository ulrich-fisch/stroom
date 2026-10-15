#!/usr/bin/env python3
"""Bou die webwerf: source/ -> site/. Gebruik: python3 tools/build.py
Tailwind-samesteller: sit die 'tailwindcss' program in tools/ of stel TAILWIND in."""
import os, re, shutil, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, OUT = f'{ROOT}/source', f'{ROOT}/site'
rd = lambda p: open(p, encoding='utf-8').read()

ACTIVE = 'text-white border-b-2 border-sky-400 pb-1'
IDLE = 'hover:text-white transition'
ACCT_ACTIVE = 'block p-2 rounded-lg bg-slate-800/60 font-semibold text-white transition'
ACCT_IDLE = 'block p-2 rounded-lg hover:bg-slate-800/80 transition'
SEARCH = ('<input type="text" id="searchInput" onkeyup="filterFilms()" placeholder="Soek films..." '
          'class="px-4 py-1.5 bg-slate-900 border border-slate-800 rounded-full text-xs text-white placeholder-slate-500 '
          'focus:outline-none focus:border-sky-500 transition w-32 sm:w-48"/>')
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap">')

def parse(text):
    m = re.match(r'<!--page\n(.*?)-->\n(.*)', text, re.S)
    meta = dict(l.split(': ', 1) if ': ' in l else (l.rstrip(':'), '') for l in m.group(1).splitlines() if l.strip())
    body = m.group(2)
    content, _, script = body.partition('<!--script-->\n')
    return meta, content.rstrip('\n'), script.strip('\n')

def build():
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    header = rd(f'{SRC}/parts/header-app.html').rstrip('\n')
    footer = rd(f'{SRC}/parts/footer-app.html').rstrip('\n')
    for f in sorted(os.listdir(f'{SRC}/pages')):
        name = f[:-5]
        meta, content, script = parse(rd(f'{SRC}/pages/{f}'))
        parts = []
        if meta.get('header') == 'app':
            h = header
            for n in ('katalogus', 'joernaal', 'oor-ons'):
                h = h.replace('{{nav:%s}}' % n, ACTIVE if meta.get('nav') == n else IDLE)
            h = h.replace('{{acct}}', ACCT_ACTIVE if meta.get('acct') == 'active' else ACCT_IDLE)
            h = h.replace('{{search}}', SEARCH if meta.get('search') == 'yes' else '')
            parts.append(h)
        parts.append(content)
        if meta.get('footer') == 'app': parts.append(footer)
        scripts = []
        if meta.get('header') == 'app' or meta.get('appjs') == 'yes': scripts.append('<script src="/app.js"></script>')
        if script: scripts.append('<script>\n' + script + '\n</script>')
        head_extra = ('\n  ' + meta['head_extra']) if meta.get('head_extra') else ''
        html = (f'<!DOCTYPE html>\n<html lang="af">\n<head>\n  <meta charset="UTF-8" />\n'
                f'  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n'
                f'  <title>{meta["title"]}</title>\n  {FONTS}\n  <link rel="stylesheet" href="/stroom.css">{head_extra}\n</head>\n'
                f'<body class="{meta["body"]}">\n\n' + '\n\n'.join(parts) + '\n\n' + '\n'.join(scripts) + '\n</body>\n</html>\n')
        open(f'{OUT}/{name}.html', 'w', encoding='utf-8').write(html)
    for f in os.listdir(f'{SRC}/static'):
        shutil.copy(f'{SRC}/static/{f}', f'{OUT}/{f}')
    tw = os.environ.get('TAILWIND') or f'{ROOT}/tools/tailwindcss'
    subprocess.run([tw, '-c', f'{ROOT}/tailwind.config.js', '-i', f'{SRC}/input.css', '-o', f'{OUT}/stroom.css', '--minify'], check=True, cwd=ROOT)
    print('Gebou:', ', '.join(sorted(os.listdir(OUT))))

if __name__ == '__main__': build()
