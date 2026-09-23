# Project Instructions

## Tech Stack
Chrome MV3 extension, zero-dependency plain JS. DeepSeek Chat API (`deepseek-chat`). No build step, no package manager, no linter.

## Code Style
- `lib/*.js` are UMD IIFEs (globalThis + module.exports); content-side modules load via the manifest `content_scripts.js` list (order matters), background via `importScripts`
- camelCase functions/variables, UPPER_SNAKE constants
- All rendering via `textContent` — never `innerHTML` (XSS prevention)
- Return `{ok:true, data}` / `{ok:false, error:'CODE'}` result objects — no exceptions for runtime errors
- Dependency injection via `createLookup(deps)` for testability
- Keep `lib/` free of `chrome.*` references

## Testing
- Run: `node --test`
- Syntax check: `node --check <file.js>`
- Framework: `node:test` + `node:assert`, flat `test()` — no describe/it
- Test files: `tests/<module>.test.js`
- E2E: `node e2e/serve.js` → `http://127.0.0.1:8123/test-page.html`

## Build & Run
- No build step — load unpacked in `chrome://extensions` (Developer mode)
- Manifest check: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`

## Project Structure
- `content.js` — hover trigger (500ms), word/context extraction (incl. open shadow roots), Shadow DOM popup, page translation collection + write-back
- `background.js` — Service Worker: cache + DeepSeek API proxy
- `popup.html/js` — API Key management panel + "translate current page" trigger
- `lib/word.js` — word validation (`WORD_RE`, `MAX_LEN=50`)
- `lib/cache.js` — LRU cache (Map-backed, capacity 500)
- `lib/lookup.js` — prompt building, JSON parsing, lookup factory
- `lib/translate.js` — page translation prompt, batching, response parsing
- `lib/dom.js` — shadow-root piercing + cross-boundary DOM traversal (open roots only; DOM-only, no Node tests)

## Conventions
- Commits: `feat:` / `fix:` / `test:` / `docs:` prefix, English imperative
- Single branch `main`, local-only
- Read `AGENTS.md` for full architecture and patterns
- Read `docs/superpowers/specs/` before changing behavior
