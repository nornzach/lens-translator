import type { UserSettings } from '../shared/settings-defaults'
import { translateImage } from './translate'

export type ShotRect = { x: number; y: number; width: number; height: number }

const MIN_CROP_PX = 8
/** Cap the crop's longest edge — hiDPI full-screen crops otherwise blow past
 * translateImage's 4MB payload ceiling; ~3000px stays ample for OCR. */
const MAX_CROP_EDGE = 3000

/**
 * Pure: CSS-px selection + DPR → device-px crop rect, clamped to the capture.
 * Returns null for slivers that carry no readable text.
 */
export function computeCropRect(
  rect: ShotRect,
  devicePixelRatio: number,
  captureWidth: number,
  captureHeight: number,
): ShotRect | null {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const x = Math.max(0, Math.floor(rect.x * scale))
  const y = Math.max(0, Math.floor(rect.y * scale))
  const right = Math.min(captureWidth, Math.ceil((rect.x + rect.width) * scale))
  const bottom = Math.min(captureHeight, Math.ceil((rect.y + rect.height) * scale))
  const width = right - x
  const height = bottom - y
  if (width < MIN_CROP_PX || height < MIN_CROP_PX) return null
  return { x, y, width, height }
}

/**
 * Capture the visible tab, crop to the selection, and OCR-translate the crop
 * through the existing multimodal image pipeline.
 */
export async function translateShotRegion(
  rect: ShotRect,
  devicePixelRatio: number,
  windowId: number | undefined,
  settings: UserSettings,
): Promise<{ ok: true; translation: string; image: string } | { ok: false; error: string }> {
  let dataUrl: string
  try {
    dataUrl =
      windowId === undefined
        ? await chrome.tabs.captureVisibleTab({ format: 'png' })
        : await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '无法截取当前页面',
    }
  }

  try {
    const cropped = await cropDataUrl(dataUrl, rect, devicePixelRatio)
    if (!cropped) return { ok: false, error: '选区太小，请框选更大的区域' }
    const result = await translateImage(cropped, settings)
    return result.ok
      ? { ok: true, translation: result.translation, image: cropped }
      : { ok: false, error: result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Crop the capture in the worker (no DOM canvas available in the SW). */
async function cropDataUrl(
  dataUrl: string,
  cssRect: ShotRect,
  devicePixelRatio: number,
): Promise<string | null> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const crop = computeCropRect(cssRect, devicePixelRatio, bitmap.width, bitmap.height)
  if (!crop) {
    bitmap.close()
    return null
  }
  const scale = Math.min(1, MAX_CROP_EDGE / Math.max(crop.width, crop.height))
  const outWidth = Math.max(1, Math.round(crop.width * scale))
  const outHeight = Math.max(1, Math.round(crop.height * scale))
  const canvas = new OffscreenCanvas(outWidth, outHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('无法创建裁剪画布')
  }
  ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, outWidth, outHeight)
  bitmap.close()
  const out = await canvas.convertToBlob({ type: 'image/png' })
  // FileReaderSync is not in the DOM lib types — base64 via btoa instead.
  const bytes = new Uint8Array(await out.arrayBuffer())
  let binary = ''
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  }
  return `data:image/png;base64,${btoa(binary)}`
}
