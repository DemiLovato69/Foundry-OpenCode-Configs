const EMPTY_PARAMETERS = { type: "object", properties: {} }
const LMS_COMPAT_FETCH = Symbol.for("palantir.lms.compat.fetch")
const GOOGLE_ALLOWED_TOP_LEVEL = new Set(["contents", "tools", "toolConfig", "generationConfig", "systemInstruction"])
const GOOGLE_ALLOWED_GENERATION_CONFIG = new Set([
  "stopSequences",
  "responseMimeType",
  "thinkingConfig",
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "maxOutputTokens",
  "seed",
  "responseSchema",
  "responseJsonSchema",
])
const GOOGLE_ALLOWED_THINKING_CONFIG = new Set(["includeThoughts", "thinkingBudget"])

const OPENAI_MODEL_RIDS = {
  "gpt-5.5": "ri.language-model-service..language-model.gpt-5-5",
  "gpt-5.4": "ri.language-model-service..language-model.gpt-5-4",
  "gpt-5.4-mini": "ri.language-model-service..language-model.gpt-5-4-mini",
  "gpt-5.4-nano": "ri.language-model-service..language-model.gpt-5-4-nano",
  "gpt-5.3-codex": "ri.language-model-service..language-model.gpt-5-3-codex",
  "gpt-5.2": "ri.language-model-service..language-model.gpt-5-2",
  "gpt-5.2-codex": "ri.language-model-service..language-model.gpt-5-2-codex",
  "gpt-5.1": "ri.language-model-service..language-model.gpt-5-1",
  "gpt-5.1-codex": "ri.language-model-service..language-model.gpt-5-1-codex",
  "gpt-5.1-codex-max": "ri.language-model-service..language-model.gpt-5-1-codex-max",
  "gpt-5.1-codex-mini": "ri.language-model-service..language-model.gpt-5-1-codex-mini",
  "gpt-5": "ri.language-model-service..language-model.gpt-5",
  "gpt-5-codex": "ri.language-model-service..language-model.gpt-5-codex",
  "gpt-5-mini": "ri.language-model-service..language-model.gpt-5-mini",
  "gpt-5-nano": "ri.language-model-service..language-model.gpt-5-nano",
  "gpt-4.1": "ri.language-model-service..language-model.gpt-4-1",
  "gpt-4.1-mini": "ri.language-model-service..language-model.gpt-4-1-mini",
  "gpt-4.1-nano": "ri.language-model-service..language-model.gpt-4-1-nano",
  "gpt-4o": "ri.language-model-service..language-model.gpt-4-o",
  "o3": "ri.language-model-service..language-model.o-3",
  "o4-mini": "ri.language-model-service..language-model.o-4-mini",
}

function normalizeFunctionTools(tools) {
  if (!Array.isArray(tools)) return

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue

    if (tool.type === "function") {
      tool.strict ??= false
      tool.parameters ??= EMPTY_PARAMETERS
    }

    normalizeFunctionTools(tool.tools)
  }
}

function requestUrl(requestInput) {
  if (typeof requestInput === "string") return requestInput
  if (requestInput instanceof URL) return requestInput.toString()
  if (requestInput && typeof requestInput === "object" && "url" in requestInput) {
    return requestInput.url
  }
  return ""
}

function lmsRequestProvider(requestInput) {
  const url = requestUrl(requestInput)
  try {
    const pathname = new URL(url).pathname
    if ((pathname.includes("/api/proxy/openai/") || pathname.includes("/api/v2/llm/proxy/openai/")) && pathname.endsWith("/responses")) return "openai"
    if ((pathname.includes("/api/proxy/anthropic/") || pathname.includes("/api/v2/llm/proxy/anthropic/")) && pathname.endsWith("/messages")) return "anthropic"
    if (pathname.includes("/api/proxy/google/") || pathname.includes("/api/v2/llm/proxy/google/")) return "google"
    if ((pathname.includes("/api/proxy/xai/") || pathname.includes("/api/v2/llm/proxy/xai/")) && pathname.endsWith("/responses")) return "xai"
  } catch {
    if ((url.includes("/api/proxy/openai/") || url.includes("/api/v2/llm/proxy/openai/")) && url.endsWith("/responses")) return "openai"
    if ((url.includes("/api/proxy/anthropic/") || url.includes("/api/v2/llm/proxy/anthropic/")) && url.endsWith("/messages")) return "anthropic"
    if (url.includes("/api/proxy/google/") || url.includes("/api/v2/llm/proxy/google/")) return "google"
    if ((url.includes("/api/proxy/xai/") || url.includes("/api/v2/llm/proxy/xai/")) && url.endsWith("/responses")) return "xai"
  }
  return undefined
}

function deleteProperty(parent, key) {
  if (!parent || typeof parent !== "object" || !(key in parent)) return
  delete parent[key]
}

function deletePropertyDeep(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) deletePropertyDeep(item, key)
    return
  }

  if (!value || typeof value !== "object") return
  deleteProperty(value, key)
  for (const child of Object.values(value)) deletePropertyDeep(child, key)
}

function pickAllowedKeys(obj, allowed) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => allowed.has(key)))
}

function normalizeLmsRequestBody(body, provider) {
  if (provider === "anthropic") {
    normalizeAnthropicMessagesBody(body)
    return body
  }

  if (provider === "google") return normalizeGoogleRequestBody(body)

  normalizeFunctionTools(body.tools)

  if (provider === "xai") {
    normalizeXaiResponsesBody(body)
    return body
  }

  if (body.model && OPENAI_MODEL_RIDS[body.model]) {
    body.model = OPENAI_MODEL_RIDS[body.model]
  }

  deleteProperty(body, "reasoningSummary")
  deleteProperty(body, "textVerbosity")
  if (body.reasoning && typeof body.reasoning === "object") deleteProperty(body.reasoning, "summary")
  if (body.text && typeof body.text === "object") deleteProperty(body.text, "verbosity")
  return body
}

function normalizeAnthropicMessagesBody(body) {
  deletePropertyDeep(body, "display")
  deletePropertyDeep(body, "eager_input_streaming")
}

function normalizeGoogleRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body

  const sanitized = pickAllowedKeys(body, GOOGLE_ALLOWED_TOP_LEVEL)
  if (sanitized.generationConfig && typeof sanitized.generationConfig === "object" && !Array.isArray(sanitized.generationConfig)) {
    sanitized.generationConfig = pickAllowedKeys(sanitized.generationConfig, GOOGLE_ALLOWED_GENERATION_CONFIG)
    if (
      sanitized.generationConfig.thinkingConfig
      && typeof sanitized.generationConfig.thinkingConfig === "object"
      && !Array.isArray(sanitized.generationConfig.thinkingConfig)
    ) {
      sanitized.generationConfig.thinkingConfig = pickAllowedKeys(
        sanitized.generationConfig.thinkingConfig,
        GOOGLE_ALLOWED_THINKING_CONFIG,
      )
    }
  }
  return sanitized
}

function normalizeXaiContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }]
  if (!Array.isArray(content)) return []

  return content.map((part) => {
    if (typeof part === "string") return { type: "input_text", text: part }
    if (!part || typeof part !== "object") return { type: "input_text", text: "" }
    if (part.type === "text" || part.type === "output_text") return { ...part, type: "input_text" }
    if (part.type === "image_url") return { ...part, type: "input_image", image_url: part.image_url?.url ?? part.image_url }
    return part
  })
}

function normalizeXaiInputItem(item) {
  if (typeof item === "string") return { type: "message", role: "user", content: normalizeXaiContent(item) }
  if (!item || typeof item !== "object") return item

  if (!item.type && "role" in item && "content" in item) item.type = "message"
  if (item.type === "message" && "content" in item) item.content = normalizeXaiContent(item.content)
  return item
}

function normalizeXaiResponsesBody(body) {
  if (typeof body.input === "string") {
    body.input = [normalizeXaiInputItem(body.input)]
  } else if (Array.isArray(body.input)) {
    body.input = body.input.map(normalizeXaiInputItem)
  }
}

function withLmsCompatFetch(previousFetch) {
  if (previousFetch?.[LMS_COMPAT_FETCH]) return previousFetch

  const compatFetch = async (requestInput, init = {}) => {
    const requestProvider = lmsRequestProvider(requestInput)
    if (!requestProvider) return previousFetch(requestInput, init)

    const headers = new Headers(init.headers ?? {})
    if (process.env.OPENCODE_API_KEY) {
      headers.set("Authorization", `Bearer ${process.env.OPENCODE_API_KEY.replace(/^Bearer\s+/i, "")}`)
    }

    const nextInit = { ...init, headers }
    if (typeof init.body !== "string") return previousFetch(requestInput, nextInit)

    try {
      const body = JSON.parse(init.body)
      const normalizedBody = normalizeLmsRequestBody(body, requestProvider)
      return previousFetch(requestInput, { ...nextInit, body: JSON.stringify(normalizedBody) })
    } catch {
      return previousFetch(requestInput, nextInit)
    }
  }
  compatFetch[LMS_COMPAT_FETCH] = true
  return compatFetch
}

export const LmsResponsesCompatibilityPlugin = async () => ({
  config: async (config) => {
    globalThis.fetch = withLmsCompatFetch(globalThis.fetch)

    for (const provider of Object.values(config.provider ?? {})) {
      const options = provider?.options
      if (!options || typeof options !== "object") continue
      const baseURL = String(options.baseURL ?? "")
      if (
        !baseURL.includes("/api/proxy/openai/")
        && !baseURL.includes("/api/v2/llm/proxy/openai/")
        && !baseURL.includes("/api/proxy/anthropic/")
        && !baseURL.includes("/api/v2/llm/proxy/anthropic/")
        && !baseURL.includes("/api/proxy/google/")
        && !baseURL.includes("/api/v2/llm/proxy/google/")
        && !baseURL.includes("/api/proxy/xai/")
        && !baseURL.includes("/api/v2/llm/proxy/xai/")
      ) continue

      const previousFetch = typeof options.fetch === "function" ? options.fetch : globalThis.fetch
      options.fetch = withLmsCompatFetch(previousFetch)
    }
  },
})
