import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Lens Translator',
  description: 'Hold a hotkey to peek Chinese translations without leaving English immersion.',
  version: '0.1.0',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Lens Translator',
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage'],
  host_permissions: ['http://*/*', 'https://*/*'],
})
