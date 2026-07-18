import { LensController } from './lens-controller'

// Guard against double-mount: on install/update the worker re-injects this script
// into already-open tabs (see sw.ts), which can race with the manifest injection.
const MOUNT_FLAG = '__lensTranslatorMounted'
const globalScope = window as unknown as Record<string, unknown>

async function main(): Promise<void> {
  if (globalScope[MOUNT_FLAG]) return
  globalScope[MOUNT_FLAG] = true
  const controller = new LensController(340)
  controller.bindListeners()
  controller.ensureMouseSeed()
  // refreshSettings() already kicks off the initial scan when auto-translate is on,
  // so we must not scan again here or the same blocks get translated twice.
  await controller.refreshSettings()
}

void main()
