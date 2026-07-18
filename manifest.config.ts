import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Lens Translator',
  description:
    'On-demand translation lens, selection popup, and bilingual page mode — Chrome built-in or your LLM.',
  version: '0.4.0',
  action: {
    // No default_popup: click toggles sticky lens. Right-click for panel/settings.
    default_title: 'Lens Translator — 点击开关透镜',
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  background: {
    // Unique filename (not index.ts) — avoids CRXJS swapping SW/content bundles
    service_worker: 'src/background/sw.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'tabs', 'scripting', 'contextMenus', 'notifications'],
  host_permissions: ['http://*/*', 'https://*/*'],
  web_accessible_resources: [
    {
      resources: ['src/bubble/index.html', 'src/popup/index.html'],
      matches: ['http://*/*', 'https://*/*'],
    },
  ],
})
