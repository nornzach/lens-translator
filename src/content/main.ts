import { LensController } from './lens-controller'

const controller = new LensController(340)

async function main(): Promise<void> {
  controller.bindListeners()
  controller.ensureMouseSeed()
  await controller.refreshSettings()
  if (controller.settings.autoTranslate) void controller.scanVisibleAndTranslate()
}

void main()
