import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatCompletionsJson, listModels } from '../../src/background/openai'

describe('chatCompletionsJson', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [{ id: 'a', translation: '你好' }],
                }),
              },
            },
          ],
        }),
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to baseURL/chat/completions with Authorization', async () => {
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-test',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain('你好')
    }
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-x')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-test')
    expect(body.response_format.type).toBe('json_schema')
  })

  it('sends DeepSeek thinking disabled when provider=deepseek and reasoning off', async () => {
    await chatCompletionsJson({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-x',
      model: 'deepseek-chat',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: false,
      provider: 'deepseek',
      reasoningPref: 'off',
    })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('sends StepFun reasoning_effort=low when off', async () => {
    await chatCompletionsJson({
      baseURL: 'https://api.stepfun.com/v1',
      apiKey: 'sk-x',
      model: 'step-3.5-flash',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: false,
      provider: 'stepfun',
      reasoningPref: 'off',
    })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.reasoning_effort).toBe('low')
  })

  it('returns error on non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    )
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'bad',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/401/)
  })

  it('surfaces the Retry-After cooldown on non-OK responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '3' } })),
    )
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })
    expect(result).toEqual({ ok: false, error: 'HTTP 429', status: 429, retryAfterMs: 3000 })
  })

  it('sends enable_thinking=false when provider=alibaba and reasoning off', async () => {
    await chatCompletionsJson({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-x',
      model: 'qwen-plus',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: false,
      provider: 'alibaba',
      reasoningPref: 'off',
    })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.enable_thinking).toBe(false)
  })

  it('strips thinking params and retries once when the endpoint 400s on them', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ items: [{ id: 'a', translation: '你好' }] }) } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatCompletionsJson({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-x',
      model: 'qwen-plus',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: false,
      provider: 'alibaba',
      reasoningPref: 'off',
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(retryBody.enable_thinking).toBeUndefined()
    expect(retryBody.thinking).toBeUndefined()
    expect(retryBody.reasoning_effort).toBeUndefined()
  })

  it('rejects insecure remote endpoints before sending the API key', async () => {
    const result = await chatCompletionsJson({
      baseURL: 'http://api.example.com/v1',
      apiKey: 'sk-secret',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })

    expect(result).toEqual({ ok: false, error: '远程 Base URL 必须使用 HTTPS' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed completion JSON at the network boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: null }),
      }),
    )
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })

    expect(result).toEqual({ ok: false, error: 'completion choices missing' })
  })
})

describe('listModels', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs {baseURL}/models and returns sorted unique ids', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen-plus' },
            { id: 'qwen-turbo' },
            { id: 'qwen-plus' },
            { id: 42 },
            { noId: true },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listModels('https://dashscope.aliyuncs.com/compatible-mode/v1', 'sk-x')

    expect(result).toEqual({ ok: true, models: ['qwen-plus', 'qwen-turbo'] })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models')
    expect(init.headers.Authorization).toBe('Bearer sk-x')
    expect(init.method).toBeUndefined()
  })

  it('returns the HTTP status on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const result = await listModels('https://dashscope.aliyuncs.com/compatible-mode/v1', 'sk-bad')
    expect(result).toEqual({ ok: false, error: 'HTTP 401', status: 401 })
  })

  it('rejects insecure endpoints without sending the key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await listModels('http://api.example.com/v1', 'sk-secret')
    expect(result).toEqual({ ok: false, error: '远程 Base URL 必须使用 HTTPS' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects malformed catalog payloads at the network boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ object: 'list' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = await listModels('https://api.example.com/v1', 'sk-x')
    expect(result).toEqual({ ok: false, error: 'model list payload missing' })
  })
})
