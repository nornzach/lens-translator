import { describe, expect, it } from 'vitest'
import { computeCropRect } from '../../src/background/shot'

describe('computeCropRect', () => {
  it('scales the CSS-px selection by the device pixel ratio', () => {
    expect(
      computeCropRect({ x: 10, y: 20, width: 100, height: 50 }, 2, 2000, 1000),
    ).toEqual({ x: 20, y: 40, width: 200, height: 100 })
  })

  it('clamps to the capture bounds', () => {
    expect(
      computeCropRect({ x: -5, y: 90, width: 200, height: 60 }, 1, 150, 120),
    ).toEqual({ x: 0, y: 90, width: 150, height: 30 })
  })

  it('falls back to scale 1 for invalid DPR values', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 }
    expect(computeCropRect(rect, 0, 500, 500)).toEqual({ x: 10, y: 10, width: 20, height: 20 })
    expect(computeCropRect(rect, Number.NaN, 500, 500)).toEqual({ x: 10, y: 10, width: 20, height: 20 })
  })

  it('returns null for slivers too small to hold readable text', () => {
    expect(computeCropRect({ x: 0, y: 0, width: 4, height: 100 }, 1, 500, 500)).toBeNull()
    expect(computeCropRect({ x: 0, y: 0, width: 100, height: 4 }, 1, 500, 500)).toBeNull()
    // Below 8 device px after scaling — DPR does not rescue it.
    expect(computeCropRect({ x: 0, y: 0, width: 3, height: 30 }, 2, 500, 500)).toBeNull()
  })

  it('returns null when the selection is entirely outside the capture', () => {
    expect(computeCropRect({ x: 500, y: 500, width: 100, height: 100 }, 1, 200, 200)).toBeNull()
  })
})
