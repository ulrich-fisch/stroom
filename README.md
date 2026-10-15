# Stroom
Afrikaans-first streaming platform (Fischbowl Media). Webwerf + toegangsslot op Cloudflare.

## Struktuur
- `source/` — bronlêers: bladsye (`pages/`), gedeelde kop/voet (`parts/`), gedeelde kode (`static/`), styl (`input.css`)
- `site/` — gegenereerde webwerf (word gepubliseer). Moenie met die hand wysig nie.
- `src/worker.js` — bediener: rekeninge, sessies, toegangsbeheer
- `tools/build.py` — bou `source/` na `site/`; `tools/test-worker.mjs` — toets die slot
- `wrangler.jsonc` — Cloudflare-opstelling (D1-databasis `DB`)

## Bou
`TAILWIND=/pad/na/tailwindcss python3 tools/build.py` (Tailwind v3 selfstaande program), dan die `site/`-lêers inskryf.
Toets: `node --experimental-sqlite tools/test-worker.mjs`
