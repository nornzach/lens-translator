# Lens Translator

Chrome MV3 extension for English immersion reading: the page stays in English by default, and you **hold a hotkey** to peek Chinese inside a **rectangular lens** over the block under your cursor. Release the key and the lens disappears — the page text is never replaced.

## Install

```bash
npm install
npm run build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

## Configure OpenAI-compatible API

Open the extension **Options** page (popup → **打开设置**, or right-click the icon → Options).

Set:

| Field    | Example                          |
|----------|----------------------------------|
| Base URL | `https://api.openai.com/v1`      |
| API Key  | your key                         |
| Model    | `gpt-4o-mini` (or any compatible model) |

Any OpenAI-compatible Chat Completions endpoint works (same path shape: `{baseURL}/chat/completions`). Source/target languages default to `en` → `zh`. Turn **Auto-translate** on to pretranslate visible blocks so the lens is ready when you need it.

## Usage

1. Browse an English page with the extension loaded and API configured.
2. Open a normal **http/https** page and **refresh** after installing/configuring.
3. **Hold `Option+Shift+L`** (Mac; Alt+Shift+L on Windows/Linux), or **short-press** to pin the lens. Rebind via Options → **录制快捷键**.
4. Move the pointer over a paragraph — Chinese appears in the rectangular lens.
5. Release (hold mode) / press hotkey again or **Esc** (sticky mode) to hide.

If nothing happens: check the page console for `[Lens Translator] ready`, and ensure you are not on `chrome://` pages.

Popup:

- Shows the current tab hostname and the configured hotkey hint
- **暂停此站** — stop translating / lens on this host
- **打开设置** — options page
- API configured status

## Privacy

- API key is stored in `chrome.storage.local`. The **background service worker** reads it for API calls; **content scripts never receive the raw key** via `get-settings` messages (it is redacted; a `configured` flag is sent instead). The options page reads storage locally for the settings form.
- Translation traffic goes only to the **user-configured** `baseURL` endpoint.
- Page text is sent to that endpoint solely for batch translation; nothing else is uploaded to third-party analytics by this extension.

MVP host permissions are broad (`http://*/*`, `https://*/*`) so auto-pretranslate works on ordinary sites without per-site permission prompts. Narrower optional permissions can be a later hardening step.

## Development

```bash
npm install
npm run dev      # Vite + CRX HMR
npm run build    # typecheck + production build → dist/
npm test         # Vitest unit tests
npm run test:watch
```

Load unpacked from `dist/` (or the CRX dev output) after build.

## Manual QA checklist

- [ ] Options save persists after reload
- [ ] Wrong API key shows error in lens (not blank forever)
- [ ] English article: visible paragraphs pretranslate; hold lens shows Chinese for hovered block
- [ ] Release hotkey: lens and outline gone; page text still English
- [ ] Scroll: new paragraphs eventually translate
- [ ] Pause site: no requests / lens respects pause
- [ ] Unconfigured: lens says 请先配置 API
