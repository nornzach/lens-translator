import { TRANSLATE_BATCH_JSON_SCHEMA } from '../shared/schema'

export type ChatJsonParams = {
  baseURL: string
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  useJsonSchema: boolean
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
  const body: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
  }
  if (params.useJsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: TRANSLATE_BATCH_JSON_SCHEMA,
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
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status }
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) return { ok: false, error: 'empty completion content' }
  return { ok: true, content }
}
