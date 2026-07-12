import { TRANSLATE_BATCH_JSON_SCHEMA } from '../shared/schema'
import {
  applyProviderRequestBody,
  resolveProvider,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'

export type ChatUserContent =
  | string
  | (
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    )[]

export type ChatJsonParams = {
  baseURL: string
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  /** Optional multimodal user content; defaults to userPrompt. */
  userContent?: ChatUserContent
  useJsonSchema: boolean
  /** Optional schema override for single-image translation responses. */
  jsonSchema?: Readonly<Record<string, unknown>>
  /** auto / openai / deepseek / stepfun */
  provider?: ProviderId
  /** off = disable or lowest reasoning (default) */
  reasoningPref?: ReasoningPref
}

export type ChatJsonResult =
  | { ok: true; content: string }
  | { ok: false; error: string; status?: number }

function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export async function chatCompletionsJson(params: ChatJsonParams): Promise<ChatJsonResult> {
  const url = joinUrl(params.baseURL, '/chat/completions')
  const provider = resolveProvider(params.provider, params.baseURL, params.model)
  const reasoning = params.reasoningPref ?? 'off'

  const body: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userContent ?? params.userPrompt },
    ],
  }

  // Provider-specific: kill/minimize thinking so translation stays fast
  applyProviderRequestBody(body, provider, reasoning)

  if (params.useJsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: params.jsonSchema ?? TRANSLATE_BATCH_JSON_SCHEMA,
    }
  } else {
    body.response_format = { type: 'json_object' }
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // If provider rejects unknown fields (thinking / reasoning_effort), retry stripped once
    if (
      res.status === 400 &&
      (body.thinking !== undefined || body.reasoning_effort !== undefined)
    ) {
      const stripped = { ...body }
      delete stripped.thinking
      delete stripped.reasoning_effort
      try {
        const retry = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify(stripped),
        })
        if (retry.ok) {
          return extractContent(await retry.json())
        }
        const t2 = await retry.text().catch(() => '')
        return {
          ok: false,
          error: `HTTP ${retry.status}: ${t2.slice(0, 200)}`,
          status: retry.status,
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'network error' }
      }
    }
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status }
  }

  return extractContent(await res.json())
}

function extractContent(data: unknown): ChatJsonResult {
  const d = data as {
    choices?: { message?: { content?: string | null; reasoning_content?: string } }[]
  }
  const msg = d.choices?.[0]?.message
  // Prefer final content; never return raw thinking-only chain as translation
  const content = msg?.content
  if (content && String(content).trim()) {
    return { ok: true, content: String(content) }
  }
  return { ok: false, error: 'empty completion content' }
}
