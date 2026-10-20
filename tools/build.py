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
SEARCH = ('<input type="text" id="searchInput" oninput="filterFilms()" placeholder="Soek titel, genre, jaar..." '
          'enterkeyhint="search" autocomplete="off" aria-label="Soek" '
          'class="px-4 py-1.5 bg-slate-900 border border-slate-800 rounded-full text-xs text-white placeholder-slate-500 '
          'focus:outline-none focus:border-sky-500 transition flex-1 min-w-0 sm:flex-none sm:w-48"/>')
MENU = 'dd absolute left-0 pt-2 w-60 max-sm:fixed max-sm:top-full max-sm:left-3 max-sm:right-3 max-sm:w-auto transition duration-200 z-50'
BOX = 'bg-slate-900/95 border border-slate-800 rounded-2xl shadow-2xl p-2 backdrop-blur-xl text-xs text-slate-300'
BTN = ('flex items-center space-x-2 bg-slate-900 border border-slate-800 px-3 sm:px-3.5 py-1.5 rounded-full hover:border-slate-700 '
       'transition focus:outline-none text-xs font-semibold text-slate-300 whitespace-nowrap')
ITEM = 'block w-full text-left p-2 rounded-lg hover:bg-slate-800/80 transition'
def _type_item(v, label): return f'<button type="button" onclick="setTypeFilter(\'{v}\', \'{label}\')" class="{ITEM}">{label}</button>'
FILTERS = ('<div class="flex items-center gap-2 shrink-0">'
           f'<div class="relative group"><button type="button" onclick="toggleDd(this, event)" class="{BTN}"><span id="typeLabel">Tipe</span><span class="text-[10px] text-slate-500">&#9660;</span></button>'
           f'<div class="{MENU}"><div class="{BOX}">' + ''.join([_type_item('all', 'Alle Inhoud'), _type_item('film', 'Films'), _type_item('reeks', 'Reekse'), _type_item('kortfilm', 'Kortfilms'), _type_item('dokumenter', 'Dokument&ecirc;re')]) + '</div></div></div>'
           f'<div class="relative group"><button type="button" onclick="toggleDd(this, event)" class="{BTN}"><span id="genreLabel">Genre</span><span class="text-[10px] text-slate-500">&#9660;</span></button>'
           f'<div class="{MENU}"><div id="genreItems" class="{BOX} max-h-80 overflow-y-auto"></div></div></div></div>')
SW_REG = "<script>if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });</script>"
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Sora:wght@700;800&display=swap">')

# Die STROOM-merk: 'n speel-driehoek gesny uit drie golwe. {{mark:30}} = staties, {{mark:30:live}} = golwe beweeg.
# Die golwe is 3 periodes lank en skuif 56 eenhede (een periode) vir 'n naatlose lus. Die klip en kleur kom van MARK_DEFS (een keer per bladsy).
_WAVE = 'c10 -10 20 -10 28 0 s18 10 28 0' * 3
MARK_DEFS = ('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
             '<clipPath id="wvClip"><path d="M16 13 Q16 8 20.3 10.5 L52.7 29.5 Q57 32 52.7 34.5 L20.3 53.5 Q16 56 16 51 Z"/></clipPath>'
             '<linearGradient id="wvGrad" gradientUnits="userSpaceOnUse" x1="14" y1="8" x2="58" y2="56">'
             '<stop offset="0" stop-color="#bae6fd"/><stop offset=".5" stop-color="#38bdf8"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs></svg>')
def mark(size, live=False):
    return (f'<svg class="wv{" wv-live" if live else ""}" width="{size}" height="{size}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">'
            f'<g clip-path="url(#wvClip)" stroke="url(#wvGrad)" stroke-width="7"><path class="w1" d="M-48 21 {_WAVE}"/>'
            f'<path class="w2" opacity=".75" d="M-48 34 {_WAVE}"/><path class="w3" opacity=".5" d="M-48 47 {_WAVE}"/></g></svg>')
def marks(html):
    return re.sub(r'\{\{mark:([0-9a-z.%]+)(:live)?\}\}', lambda m: mark(m.group(1), bool(m.group(2))), html)

_TAB_ICON = {
    'tuis': '<path d="M4 11 L12 4 L20 11 V20 H4 Z"/>',
    'soek': '<circle cx="11" cy="11" r="7"/><path d="M20 20 L16 16"/>',
    'lys': '<path d="M6 4 H18 V21 L12 17 L6 21 Z"/>',
    'rekening': '<circle cx="12" cy="8" r="4"/><path d="M4 21 C4 16 8 14 12 14 S20 16 20 21"/>',
}
def tabs(active):
    items = [('tuis', 'Tuis', 'katalogus.html', ''), ('soek', 'Soek', 'katalogus.html?soek=1', " onclick=\"tabKlik(event, 'soek')\""),
             ('lys', 'My Lys', 'katalogus.html?lys=1', " onclick=\"tabKlik(event, 'lys')\""), ('rekening', 'Rekening', 'rekening.html', '')]
    out = ['<nav id="tabBar" class="md:hidden fixed bottom-0 inset-x-0 z-40 flex bg-[#091020]/95 backdrop-blur-xl border-t border-[#1b2a4a]" style="padding-bottom:env(safe-area-inset-bottom)" aria-label="Hoofkieslys">']
    for k, label, href, extra in items:
        on = k == active
        out.append(f'<a href="{href}"{extra} class="flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] text-[11px] {"text-sky-400 font-semibold" if on else "text-slate-400 font-medium"}"{" aria-current=\"page\"" if on else ""}>'
                   f'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{_TAB_ICON[k]}</svg>{label}</a>')
    out.append('</nav>')
    return ''.join(out)

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
            h = h.replace('{{filters}}', FILTERS if meta.get('filters') == 'yes' else '')
            h = h.replace('{{search}}', SEARCH if meta.get('search') == 'yes' else '')
            parts.append(h)
        parts.append(content)
        if meta.get('footer') == 'app': parts.append(footer)
        if meta.get('tabs') == 'yes': parts.append(tabs(meta.get('tab', '')))
        scripts = []
        if meta.get('header') == 'app' or meta.get('appjs') == 'yes': scripts.append('<script src="/app.js"></script>')
        if script: scripts.append('<script>\n' + script + '\n</script>')
        head_extra = ('\n  ' + meta['head_extra']) if meta.get('head_extra') else ''
        html = (f'<!DOCTYPE html>\n<html lang="af">\n<head>\n  <meta charset="UTF-8" />\n'
                f'  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>\n'
                f'  <meta name="theme-color" content="#070c18">\n  <link rel="manifest" href="/manifest.webmanifest">\n'
                f'  <link rel="icon" type="image/png" href="/favicon.png">\n  <link rel="apple-touch-icon" href="/apple-touch-icon.png">\n'
                f'  <meta name="apple-mobile-web-app-capable" content="yes">\n  <meta name="mobile-web-app-capable" content="yes">\n'
                f'  <meta name="apple-mobile-web-app-title" content="Stroom">\n'
                f'  <title>{meta["title"]}</title>\n  {FONTS}\n  <link rel="stylesheet" href="/stroom.css">{head_extra}\n</head>\n'
                f'<body class="{meta["body"]}{" has-tabs" if meta.get("tabs") == "yes" else ""}">\n{MARK_DEFS}\n\n' + '\n\n'.join(parts) + '\n\n' + '\n'.join(scripts) + '\n' + SW_REG + '\n</body>\n</html>\n')
        open(f'{OUT}/{name}.html', 'w', encoding='utf-8').write(marks(html))
    for f in os.listdir(f'{SRC}/static'):
        shutil.copy(f'{SRC}/static/{f}', f'{OUT}/{f}')
    tw = os.environ.get('TAILWIND') or f'{ROOT}/tools/tailwindcss'
    subprocess.run([tw, '-c', f'{ROOT}/tailwind.config.js', '-i', f'{SRC}/input.css', '-o', f'{OUT}/stroom.css', '--minify'], check=True, cwd=ROOT)
    print('Gebou:', ', '.join(sorted(os.listdir(OUT))))

if __name__ == '__main__': build()
