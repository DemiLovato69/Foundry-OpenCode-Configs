const RID = "ri.language-model-service..language-model.";

const OPENAI_MODELS = {
    "gpt-6-sol": "gpt-6-sol",
    "gpt-6-luna": "gpt-6-luna",
    "gpt-6-astra": "gpt-6-astra",
    "gpt-5.6-sol": "gpt-5-6-sol",
    "gpt-5.6-terra": "gpt-5-6-terra",
    "gpt-5.6-luna": "gpt-5-6-luna",
    "gpt-5.5": "gpt-5-5",
    "gpt-5.4": "gpt-5-4",
    "gpt-5.4-mini": "gpt-5-4-mini",
    "gpt-5.4-nano": "gpt-5-4-nano",
    "gpt-5.3-codex": "gpt-5-3-codex",
    "gpt-5.2": "gpt-5-2",
    "gpt-5.1": "gpt-5-1",
    "gpt-5.1-codex": "gpt-5-1-codex",
    "gpt-5.1-codex-mini": "gpt-5-1-codex-mini",
    "gpt-5": "gpt-5",
    "gpt-5-codex": "gpt-5-codex",
    "gpt-5-mini": "gpt-5-mini",
    "gpt-5-nano": "gpt-5-nano",
    "gpt-4.1": "gpt-4-1",
    "gpt-4.1-mini": "gpt-4-1-mini",
    "gpt-4.1-nano": "gpt-4-1-nano",
    "gpt-4o": "gpt-4-o",
    o3: "o-3",
    "o4-mini": "o-4-mini",
    "codex-auto-review": "codex-auto-review",
};

const ANTHROPIC_MODELS = {
    "claude-opus-5": "anthropic-claude-5-opus",
    "claude-opus-5-5": "anthropic-claude-5-5-opus",
};

function stripAnthropicFields(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        for (const item of value) stripAnthropicFields(item);
        return;
    }
    delete value.display;
    delete value.eager_input_streaming;
    for (const item of Object.values(value)) stripAnthropicFields(item);
}

function containsInputFile(value) {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsInputFile);
    return value.type === "input_file" || Object.values(value).some(containsInputFile);
}

export function normalizeLmsRequestBody(body, provider) {
    if (provider === "anthropic") {
        if (ANTHROPIC_MODELS[body.model]) body.model = RID + ANTHROPIC_MODELS[body.model];
        stripAnthropicFields(body);
        return body;
    }

    if (containsInputFile(body.input)) {
        throw new Error("Palantir proxy does not support OpenAI input_file attachments");
    }
    if (OPENAI_MODELS[body.model]) body.model = RID + OPENAI_MODELS[body.model];
    for (const tool of body.tools ?? []) {
        if (tool.type !== "function") continue;
        tool.strict ??= false;
        tool.parameters ??= { type: "object", properties: {} };
    }
    delete body.reasoningSummary;
    delete body.textVerbosity;
    if (body.reasoning) delete body.reasoning.summary;
    if (body.text) delete body.text.verbosity;
    return body;
}

export const LmsResponsesCompatibilityPlugin = async () => ({
    config: (config) => {
        for (const [provider, endpoint] of [["openai", "responses"], ["anthropic", "messages"]]) {
            const options = config.provider?.[provider]?.options;
            if (!options?.baseURL) continue;
            const base = new URL(options.baseURL);
            const path = `${base.pathname.replace(/\/+$/, "")}/${endpoint}`;
            const previousFetch = options.fetch ?? globalThis.fetch;

            options.fetch = (input, init = {}) => {
                const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
                if (url.origin !== base.origin || url.pathname !== path) {
                    return previousFetch(input, init);
                }

                const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
                if (process.env.OPENCODE_API_KEY) {
                    headers.set("Authorization", `Bearer ${process.env.OPENCODE_API_KEY.replace(/^Bearer\s+/i, "")}`);
                }
                let body = init.body;
                if (typeof body === "string") {
                    try {
                        body = JSON.parse(body);
                    } catch {
                        return previousFetch(input, { ...init, headers });
                    }
                    body = JSON.stringify(normalizeLmsRequestBody(body, provider));
                }
                return previousFetch(input, { ...init, headers, ...(typeof body === "string" ? { body } : {}) });
            };
        }
    },
});
