import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const EMPTY_PARAMETERS = { type: "object", properties: {} };
const LMS_COMPAT_FETCH = Symbol.for("palantir.lms.compat.fetch");
const PDF_RENDER_CACHE_MAX = 12;
const PDF_RENDER_RECENT_INPUT_ITEMS = 32;
const PDF_RENDER_MAX_PAGES_PER_REQUEST = 8;
const PDF_RENDER_MAX_BYTES = 20 * 1024 * 1024;
const PDF_RENDER_MAX_IMAGE_URL_CHARS_PER_REQUEST = 8 * 1024 * 1024;
const PDF_RENDER_DPI = 110;
const PDF_RENDER_MAX_WIDTH = 1400;
const PDF_RENDER_MAX_HEIGHT = 1800;
const PDF_RENDER_JPEG_QUALITY = 70;
const PDF_RENDER_TIMEOUT_MS = 30_000;
const GOOGLE_ALLOWED_TOP_LEVEL = new Set([
    "contents",
    "tools",
    "toolConfig",
    "generationConfig",
    "systemInstruction",
]);
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
]);
const GOOGLE_ALLOWED_THINKING_CONFIG = new Set([
    "includeThoughts",
    "thinkingBudget",
]);

const OPENAI_MODEL_RIDS = {
    "gpt-5.6-sol": "ri.language-model-service..language-model.gpt-5-6-sol",
    "gpt-5.6-terra": "ri.language-model-service..language-model.gpt-5-6-terra",
    "gpt-5.6-luna": "ri.language-model-service..language-model.gpt-5-6-luna",
    "gpt-5.5": "ri.language-model-service..language-model.gpt-5-5",
    "gpt-5.4": "ri.language-model-service..language-model.gpt-5-4",
    "gpt-5.4-mini": "ri.language-model-service..language-model.gpt-5-4-mini",
    "gpt-5.4-nano": "ri.language-model-service..language-model.gpt-5-4-nano",
    "gpt-5.3-codex": "ri.language-model-service..language-model.gpt-5-3-codex",
    "gpt-5.2": "ri.language-model-service..language-model.gpt-5-2",
    "gpt-5.2-codex": "ri.language-model-service..language-model.gpt-5-2-codex",
    "gpt-5.1": "ri.language-model-service..language-model.gpt-5-1",
    "gpt-5.1-codex": "ri.language-model-service..language-model.gpt-5-1-codex",
    "gpt-5.1-codex-max":
        "ri.language-model-service..language-model.gpt-5-1-codex-max",
    "gpt-5.1-codex-mini":
        "ri.language-model-service..language-model.gpt-5-1-codex-mini",
    "gpt-5": "ri.language-model-service..language-model.gpt-5",
    "gpt-5-codex": "ri.language-model-service..language-model.gpt-5-codex",
    "gpt-5-mini": "ri.language-model-service..language-model.gpt-5-mini",
    "gpt-5-nano": "ri.language-model-service..language-model.gpt-5-nano",
    "gpt-4.1": "ri.language-model-service..language-model.gpt-4-1",
    "gpt-4.1-mini": "ri.language-model-service..language-model.gpt-4-1-mini",
    "gpt-4.1-nano": "ri.language-model-service..language-model.gpt-4-1-nano",
    "gpt-4o": "ri.language-model-service..language-model.gpt-4-o",
    o3: "ri.language-model-service..language-model.o-3",
    "o4-mini": "ri.language-model-service..language-model.o-4-mini",
};

const pdfRenderCache = new Map();

const PDF_RENDER_SCRIPT = String.raw`
import base64
import io
import json
import sys

try:
    import fitz
    from PIL import Image
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"renderer unavailable: {exc}"}))
    sys.exit(0)


def selected_pages(total, limit):
    if total <= 0 or limit <= 0:
        return []
    if total <= limit:
        return list(range(total))
    pages = set()
    for i in range(limit):
        pages.add(round(i * (total - 1) / (limit - 1)))
    return sorted(pages)


try:
    payload = json.load(sys.stdin)
    pdf = base64.b64decode(payload["pdfBase64"], validate=True)
    doc = fitz.open(stream=pdf, filetype="pdf")
    total = doc.page_count
    scale = float(payload.get("dpi", 110)) / 72.0
    mat = fitz.Matrix(scale, scale)
    max_pages = int(payload.get("maxPages", 8))
    max_width = int(payload.get("maxWidth", 1400))
    max_height = int(payload.get("maxHeight", 1800))
    quality = int(payload.get("jpegQuality", 70))
    pages = []

    for index in selected_pages(total, max_pages):
        page = doc.load_page(index)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        image = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        image.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=quality, optimize=True)
        pages.append({
            "page": index + 1,
            "width": image.width,
            "height": image.height,
            "data": base64.b64encode(buf.getvalue()).decode("ascii"),
        })

    doc.close()
    print(json.dumps({"ok": True, "totalPages": total, "pages": pages}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`;

function normalizeFunctionTools(tools) {
    if (!Array.isArray(tools)) return;

    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;

        if (tool.type === "function") {
            tool.strict ??= false;
            tool.parameters ??= EMPTY_PARAMETERS;
        }

        normalizeFunctionTools(tool.tools);
    }
}

function requestUrl(requestInput) {
    if (typeof requestInput === "string") return requestInput;
    if (requestInput instanceof URL) return requestInput.toString();
    if (
        requestInput &&
        typeof requestInput === "object" &&
        "url" in requestInput
    ) {
        return requestInput.url;
    }
    return "";
}

function lmsRequestProvider(requestInput) {
    const url = requestUrl(requestInput);
    try {
        const pathname = new URL(url).pathname;
        if (
            (pathname.includes("/api/proxy/openai/") ||
                pathname.includes("/api/v2/llm/proxy/openai/")) &&
            pathname.endsWith("/responses")
        )
            return "openai";
        if (
            (pathname.includes("/api/proxy/anthropic/") ||
                pathname.includes("/api/v2/llm/proxy/anthropic/")) &&
            pathname.endsWith("/messages")
        )
            return "anthropic";
        if (
            pathname.includes("/api/proxy/google/") ||
            pathname.includes("/api/v2/llm/proxy/google/")
        )
            return "google";
        if (
            (pathname.includes("/api/proxy/xai/") ||
                pathname.includes("/api/v2/llm/proxy/xai/")) &&
            pathname.endsWith("/responses")
        )
            return "xai";
    } catch {
        if (
            (url.includes("/api/proxy/openai/") ||
                url.includes("/api/v2/llm/proxy/openai/")) &&
            url.endsWith("/responses")
        )
            return "openai";
        if (
            (url.includes("/api/proxy/anthropic/") ||
                url.includes("/api/v2/llm/proxy/anthropic/")) &&
            url.endsWith("/messages")
        )
            return "anthropic";
        if (
            url.includes("/api/proxy/google/") ||
            url.includes("/api/v2/llm/proxy/google/")
        )
            return "google";
        if (
            (url.includes("/api/proxy/xai/") ||
                url.includes("/api/v2/llm/proxy/xai/")) &&
            url.endsWith("/responses")
        )
            return "xai";
    }
    return undefined;
}

function deleteProperty(parent, key) {
    if (!parent || typeof parent !== "object" || !(key in parent)) return;
    delete parent[key];
}

function deletePropertyDeep(value, key) {
    if (Array.isArray(value)) {
        for (const item of value) deletePropertyDeep(item, key);
        return;
    }

    if (!value || typeof value !== "object") return;
    deleteProperty(value, key);
    for (const child of Object.values(value)) deletePropertyDeep(child, key);
}

function pickAllowedKeys(obj, allowed) {
    return Object.fromEntries(
        Object.entries(obj).filter(([key]) => allowed.has(key)),
    );
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inputText(text) {
    return { type: "input_text", text };
}

function parseDataUrl(value) {
    if (typeof value !== "string") return undefined;
    const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(value);
    if (!match) return undefined;
    return {
        mediaType: match[1].toLowerCase(),
        base64: match[2].replace(/\s+/g, ""),
    };
}

function estimateBase64Bytes(base64) {
    const normalized = base64.replace(/=+$/, "");
    return Math.floor((normalized.length * 3) / 4);
}

function hashBase64(base64) {
    return createHash("sha256").update(base64).digest("hex");
}

function pdfCandidate(part, inputIndex) {
    if (!isRecord(part) || part.type !== "input_file") return undefined;
    const data = parseDataUrl(part.file_data);
    if (!data || data.mediaType !== "application/pdf") return undefined;
    const byteLength = estimateBase64Bytes(data.base64);
    return {
        part,
        inputIndex,
        base64: data.base64,
        byteLength,
        hash: hashBase64(data.base64),
        filename: String(part.filename ?? "document.pdf"),
    };
}

function collectPdfCandidates(value, result = [], inputIndex) {
    if (Array.isArray(value)) {
        for (const item of value) collectPdfCandidates(item, result, inputIndex);
        return result;
    }

    if (!isRecord(value)) return result;
    const candidate = pdfCandidate(value, inputIndex);
    if (candidate) result.push(candidate);
    for (const child of Object.values(value))
        collectPdfCandidates(child, result, inputIndex);
    return result;
}

function collectOpenAiPdfCandidates(body) {
    if (!Array.isArray(body?.input)) return collectPdfCandidates(body);

    const result = [];
    for (let i = 0; i < body.input.length; i++) {
        collectPdfCandidates(body.input[i], result, i);
    }
    return result;
}

function newestDistinctPdfParts(candidates, recentInputStart) {
    const selected = new WeakSet();
    const seen = new Set();
    for (let i = candidates.length - 1; i >= 0; i--) {
        const candidate = candidates[i];
        if (
            typeof candidate.inputIndex === "number" &&
            candidate.inputIndex < recentInputStart
        )
            continue;
        if (seen.has(candidate.hash)) continue;
        seen.add(candidate.hash);
        selected.add(candidate.part);
        if (seen.size >= PDF_RENDER_MAX_PAGES_PER_REQUEST) break;
    }
    return selected;
}

function rememberPdfRender(cacheKey, rendered) {
    if (pdfRenderCache.has(cacheKey)) pdfRenderCache.delete(cacheKey);
    pdfRenderCache.set(cacheKey, rendered);
    while (pdfRenderCache.size > PDF_RENDER_CACHE_MAX) {
        const oldest = pdfRenderCache.keys().next().value;
        pdfRenderCache.delete(oldest);
    }
}

async function renderPdfPages(candidate, maxPages) {
    const cacheKey = `${candidate.hash}:${maxPages}`;
    const cached = pdfRenderCache.get(cacheKey);
    if (cached) return cached;

    const rendered = await new Promise((resolve) => {
        const child = spawn(
            "python3",
            ["-c", PDF_RENDER_SCRIPT],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ ok: false, error: "PDF rendering timed out" });
        }, PDF_RENDER_TIMEOUT_MS);
        const stdout = [];
        const stderr = [];

        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ ok: false, error: error.message });
        });
        child.on("close", () => {
            clearTimeout(timer);
            try {
                const raw = Buffer.concat(stdout).toString("utf8").trim();
                const parsed = JSON.parse(raw || "{}");
                if (!parsed.ok && stderr.length) {
                    parsed.error ??= Buffer.concat(stderr).toString("utf8").trim();
                }
                resolve(parsed);
            } catch (error) {
                const err = Buffer.concat(stderr).toString("utf8").trim();
                resolve({
                    ok: false,
                    error: err || error.message || "PDF renderer returned invalid JSON",
                });
            }
        });

        child.stdin.end(
            JSON.stringify({
                pdfBase64: candidate.base64,
                maxPages,
                dpi: PDF_RENDER_DPI,
                maxWidth: PDF_RENDER_MAX_WIDTH,
                maxHeight: PDF_RENDER_MAX_HEIGHT,
                jpegQuality: PDF_RENDER_JPEG_QUALITY,
            }),
        );
    });

    if (rendered.ok) rememberPdfRender(cacheKey, rendered);
    return rendered;
}

async function normalizePdfInputFile(part, ctx) {
    const filename = String(part.filename ?? "attached file");

    if (part.file_url) {
        return [
            inputText(
                `Omitted unsupported file attachment "${filename}" from ${part.file_url}: this LMS endpoint does not accept Responses API input_file parts.`,
            ),
        ];
    }

    if (part.file_id) {
        return [
            inputText(
                `Omitted unsupported hosted file attachment "${filename}" (${part.file_id}): this LMS endpoint does not accept Responses API input_file parts.`,
            ),
        ];
    }

    const data = parseDataUrl(part.file_data);
    if (!data) {
        return [
            inputText(
                `Omitted unsupported file attachment "${filename}": this LMS endpoint does not accept Responses API input_file parts.`,
            ),
        ];
    }

    if (data.mediaType !== "application/pdf") {
        return [
            inputText(
                `Omitted unsupported ${data.mediaType} file attachment "${filename}": this LMS endpoint does not accept Responses API input_file parts.`,
            ),
        ];
    }

    const candidate = {
        filename,
        base64: data.base64,
        byteLength: estimateBase64Bytes(data.base64),
        hash: hashBase64(data.base64),
    };

    if (
        typeof ctx.currentInputIndex === "number" &&
        ctx.currentInputIndex < ctx.recentInputStart
    ) {
        return [
            inputText(
                `Omitted older PDF attachment "${filename}" from earlier session history. Re-read the file if its contents are needed again.`,
            ),
        ];
    }

    if (!ctx.selectedPdfParts.has(part)) {
        return [
            inputText(
                `Omitted older PDF attachment "${filename}" because newer PDF attachments were prioritized for the ${PDF_RENDER_MAX_PAGES_PER_REQUEST}-page render budget.`,
            ),
        ];
    }

    if (ctx.renderedPdfHashes.has(candidate.hash)) {
        return [
            inputText(
                `PDF attachment "${filename}" is a duplicate of a PDF already rendered earlier in this request. Refer to the previously rendered page images.`,
            ),
        ];
    }

    if (candidate.byteLength > PDF_RENDER_MAX_BYTES) {
        ctx.renderedPdfHashes.add(candidate.hash);
        return [
            inputText(
                `Omitted PDF attachment "${filename}" (${candidate.byteLength} bytes) because it exceeds the ${PDF_RENDER_MAX_BYTES}-byte PDF render limit for this LMS compatibility layer.`,
            ),
        ];
    }

    if (ctx.pageBudgetRemaining <= 0) {
        return [
            inputText(
                `Omitted PDF attachment "${filename}" because the ${PDF_RENDER_MAX_PAGES_PER_REQUEST}-page PDF render budget for this request was already exhausted.`,
            ),
        ];
    }

    const rendered = await renderPdfPages(candidate, ctx.pageBudgetRemaining);
    ctx.renderedPdfHashes.add(candidate.hash);
    if (!rendered.ok) {
        return [
            inputText(
                `Could not render PDF attachment "${filename}" for this LMS endpoint: ${rendered.error ?? "unknown rendering error"}.`,
            ),
        ];
    }

    const parts = [];
    const totalPages = Number(rendered.totalPages ?? 0);
    const pages = Array.isArray(rendered.pages) ? rendered.pages : [];
    const chosen = [];
    for (const page of pages) {
        const imageUrl = `data:image/jpeg;base64,${page.data}`;
        if (ctx.imageUrlCharsRemaining < imageUrl.length) break;
        ctx.imageUrlCharsRemaining -= imageUrl.length;
        chosen.push({ ...page, imageUrl });
    }
    ctx.pageBudgetRemaining -= chosen.length;

    if (chosen.length === 0) {
        return [
            inputText(
                `Could not include rendered pages for PDF attachment "${filename}" because the rendered image byte budget was exhausted.`,
            ),
        ];
    }

    const selectedPages = chosen.map((page) => page.page).join(", ");
    const truncated = totalPages > chosen.length ? " Only sampled pages were included." : "";
    parts.push(
        inputText(
            `PDF attachment "${filename}" was converted to page images for this LMS endpoint. Included page(s): ${selectedPages} of ${totalPages || "unknown"}.${truncated}`,
        ),
    );
    for (const page of chosen) {
        parts.push(inputText(`[PDF "${filename}" page ${page.page}${totalPages ? ` of ${totalPages}` : ""}]`));
        parts.push({ type: "input_image", image_url: page.imageUrl });
    }
    return parts;
}

async function normalizeInputFiles(value, ctx, inputIndex) {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (isRecord(item) && item.type === "input_file") {
                ctx.currentInputIndex = inputIndex;
                const replacement = await normalizePdfInputFile(item, ctx);
                value.splice(i, 1, ...replacement);
                i += replacement.length - 1;
                continue;
            }
            await normalizeInputFiles(item, ctx, inputIndex);
        }
        return;
    }

    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
        if (key === "input" && Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                await normalizeInputFiles(child[i], ctx, i);
            }
            continue;
        }

        if (isRecord(child) && child.type === "input_file") {
            ctx.currentInputIndex = inputIndex;
            const replacement = await normalizePdfInputFile(child, ctx);
            value[key] = replacement[0];
            continue;
        }
        await normalizeInputFiles(child, ctx, inputIndex);
    }
}

async function normalizeOpenAiResponsesBody(body) {
    const candidates = collectOpenAiPdfCandidates(body);
    const recentInputStart = Array.isArray(body?.input)
        ? Math.max(0, body.input.length - PDF_RENDER_RECENT_INPUT_ITEMS)
        : 0;
    const ctx = {
        recentInputStart,
        selectedPdfParts: newestDistinctPdfParts(candidates, recentInputStart),
        renderedPdfHashes: new Set(),
        pageBudgetRemaining: PDF_RENDER_MAX_PAGES_PER_REQUEST,
        imageUrlCharsRemaining: PDF_RENDER_MAX_IMAGE_URL_CHARS_PER_REQUEST,
    };

    await normalizeInputFiles(body, ctx);

    if (body.model && OPENAI_MODEL_RIDS[body.model]) {
        body.model = OPENAI_MODEL_RIDS[body.model];
    }

    deleteProperty(body, "reasoningSummary");
    deleteProperty(body, "textVerbosity");
    if (body.reasoning && typeof body.reasoning === "object")
        deleteProperty(body.reasoning, "summary");
    if (body.text && typeof body.text === "object")
        deleteProperty(body.text, "verbosity");
    return body;
}

export async function normalizeLmsRequestBody(body, provider) {
    if (provider === "anthropic") {
        normalizeAnthropicMessagesBody(body);
        return body;
    }

    if (provider === "google") return normalizeGoogleRequestBody(body);

    normalizeFunctionTools(body.tools);

    if (provider === "xai") {
        normalizeXaiResponsesBody(body);
        return body;
    }

    return normalizeOpenAiResponsesBody(body);
}

function normalizeAnthropicMessagesBody(body) {
    deletePropertyDeep(body, "display");
    deletePropertyDeep(body, "eager_input_streaming");
}

function normalizeGoogleRequestBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;

    const sanitized = pickAllowedKeys(body, GOOGLE_ALLOWED_TOP_LEVEL);
    if (
        sanitized.generationConfig &&
        typeof sanitized.generationConfig === "object" &&
        !Array.isArray(sanitized.generationConfig)
    ) {
        sanitized.generationConfig = pickAllowedKeys(
            sanitized.generationConfig,
            GOOGLE_ALLOWED_GENERATION_CONFIG,
        );
        if (
            sanitized.generationConfig.thinkingConfig &&
            typeof sanitized.generationConfig.thinkingConfig === "object" &&
            !Array.isArray(sanitized.generationConfig.thinkingConfig)
        ) {
            sanitized.generationConfig.thinkingConfig = pickAllowedKeys(
                sanitized.generationConfig.thinkingConfig,
                GOOGLE_ALLOWED_THINKING_CONFIG,
            );
        }
    }
    return sanitized;
}

function normalizeXaiContent(content) {
    if (typeof content === "string")
        return [{ type: "input_text", text: content }];
    if (!Array.isArray(content)) return [];

    return content.map((part) => {
        if (typeof part === "string") return { type: "input_text", text: part };
        if (!part || typeof part !== "object")
            return { type: "input_text", text: "" };
        if (part.type === "text" || part.type === "output_text")
            return { ...part, type: "input_text" };
        if (part.type === "image_url")
            return {
                ...part,
                type: "input_image",
                image_url: part.image_url?.url ?? part.image_url,
            };
        return part;
    });
}

function normalizeXaiInputItem(item) {
    if (typeof item === "string")
        return {
            type: "message",
            role: "user",
            content: normalizeXaiContent(item),
        };
    if (!item || typeof item !== "object") return item;

    if (!item.type && "role" in item && "content" in item)
        item.type = "message";
    if (item.type === "message" && "content" in item)
        item.content = normalizeXaiContent(item.content);
    return item;
}

function normalizeXaiResponsesBody(body) {
    if (typeof body.input === "string") {
        body.input = [normalizeXaiInputItem(body.input)];
    } else if (Array.isArray(body.input)) {
        body.input = body.input.map(normalizeXaiInputItem);
    }
}

function withLmsCompatFetch(previousFetch) {
    if (previousFetch?.[LMS_COMPAT_FETCH]) return previousFetch;

    const compatFetch = async (requestInput, init = {}) => {
        const requestProvider = lmsRequestProvider(requestInput);
        if (!requestProvider) return previousFetch(requestInput, init);

        const headers = new Headers(init.headers ?? {});
        if (process.env.OPENCODE_API_KEY) {
            headers.set(
                "Authorization",
                `Bearer ${process.env.OPENCODE_API_KEY.replace(/^Bearer\s+/i, "")}`,
            );
        }

        const nextInit = { ...init, headers };
        if (typeof init.body !== "string")
            return previousFetch(requestInput, nextInit);

        try {
            const body = JSON.parse(init.body);
            const normalizedBody = await normalizeLmsRequestBody(
                body,
                requestProvider,
            );
            return previousFetch(requestInput, {
                ...nextInit,
                body: JSON.stringify(normalizedBody),
            });
        } catch {
            return previousFetch(requestInput, nextInit);
        }
    };
    compatFetch[LMS_COMPAT_FETCH] = true;
    return compatFetch;
}

export const LmsResponsesCompatibilityPlugin = async () => ({
    config: async (config) => {
        globalThis.fetch = withLmsCompatFetch(globalThis.fetch);

        for (const provider of Object.values(config.provider ?? {})) {
            const options = provider?.options;
            if (!options || typeof options !== "object") continue;
            const baseURL = String(options.baseURL ?? "");
            if (
                !baseURL.includes("/api/proxy/openai/") &&
                !baseURL.includes("/api/v2/llm/proxy/openai/") &&
                !baseURL.includes("/api/proxy/anthropic/") &&
                !baseURL.includes("/api/v2/llm/proxy/anthropic/") &&
                !baseURL.includes("/api/proxy/google/") &&
                !baseURL.includes("/api/v2/llm/proxy/google/") &&
                !baseURL.includes("/api/proxy/xai/") &&
                !baseURL.includes("/api/v2/llm/proxy/xai/")
            )
                continue;

            const previousFetch =
                typeof options.fetch === "function"
                    ? options.fetch
                    : globalThis.fetch;
            options.fetch = withLmsCompatFetch(previousFetch);
        }
    },
});
