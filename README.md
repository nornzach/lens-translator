# Lens Translator

Chrome MV3 extension: hold a hotkey to peek Chinese translations without leaving English immersion.

## Development

```bash
npm install
npm run dev      # Vite + CRX HMR
npm run build    # typecheck + production build → dist/
npm test         # Vitest
```

Load unpacked from `dist/` in `chrome://extensions` (Developer mode).

## Permissions

MVP uses broad host permissions (`http://*/*`, `https://*/*`) for simpler auto-pretranslate across pages. Optional/narrower host permissions can be a later hardening task.
