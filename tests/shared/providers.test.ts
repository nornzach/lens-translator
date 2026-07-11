import { describe, it, expect } from 'vitest'
import {
  detectProvider,
  resolveProvider,
  applyProviderRequestBody,
} from '../../src/shared/providers'

describe('detectProvider', () => {
  it('detects deepseek from host', () => {
    expect(detectProvider('https://api.deepseek.com', 'deepseek-chat')).toBe('deepseek')
  })

  it('detects stepfun from host or model', () => {
    expect(detectProvider('https://api.stepfun.com/v1', 'step-3.5-flash')).toBe('stepfun')
    expect(detectProvider('https://api.stepfun.ai/v1', 'foo')).toBe('stepfun')
    expect(detectProvider('https://other.example/v1', 'step-3.7-flash')).toBe('stepfun')
  })
})

describe('applyProviderRequestBody', () => {
  it('disables deepseek thinking when off', () => {
    const body: Record<string, unknown> = { model: 'deepseek-chat' }
    applyProviderRequestBody(body, 'deepseek', 'off')
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('sets stepfun reasoning_effort low when off', () => {
    const body: Record<string, unknown> = { model: 'step-3.5-flash' }
    applyProviderRequestBody(body, 'stepfun', 'off')
    expect(body.reasoning_effort).toBe('low')
  })

  it('sets stepfun medium/high', () => {
    const body: Record<string, unknown> = {}
    applyProviderRequestBody(body, 'stepfun', 'high')
    expect(body.reasoning_effort).toBe('high')
  })

  it('leaves openai body alone', () => {
    const body: Record<string, unknown> = { model: 'gpt-4o-mini' }
    applyProviderRequestBody(body, 'openai', 'off')
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})

describe('resolveProvider', () => {
  it('respects explicit preference', () => {
    expect(resolveProvider('deepseek', 'https://api.openai.com/v1', 'gpt')).toBe('deepseek')
  })
})
