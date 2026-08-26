import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { normalizeLmsRequestBody } from "../plugins/lms-responses-compat.js";

const pdfBase64 = execFileSync(
    "python3",
    [
        "-c",
        String.raw`
import base64
import fitz

doc = fitz.open()
for index in range(10):
    page = doc.new_page(width=300, height=200)
    page.insert_text((40, 90), f"Regression PDF page {index + 1}", fontsize=18)
payload = doc.tobytes()
doc.close()
print(base64.b64encode(payload).decode("ascii"))
`,
    ],
    { encoding: "utf8" },
).trim();

function pdfMessage(filename = "regression.pdf") {
    return {
        type: "message",
        role: "user",
        content: [
            { type: "input_text", text: "Please inspect this file." },
            {
                type: "input_file",
                filename,
                file_data: `data:application/pdf;base64,${pdfBase64}`,
            },
        ],
    };
}

function textMessage(index) {
    return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `History message ${index}` }],
    };
}

function imagePartCount(value) {
    return JSON.stringify(value).match(/"type":"input_image"/g)?.length ?? 0;
}

function inputTexts(value, result = []) {
    if (Array.isArray(value)) {
        for (const item of value) inputTexts(item, result);
        return result;
    }

    if (!value || typeof value !== "object") return result;
    if (value.type === "input_text" && typeof value.text === "string") {
        result.push(value.text);
    }
    for (const child of Object.values(value)) inputTexts(child, result);
    return result;
}

const body = {
    model: "gpt-5.6-terra",
    input: [pdfMessage()],
    reasoning: { summary: "auto", effort: "medium" },
    text: { verbosity: "high" },
    tools: [{ type: "function", name: "noop" }],
};

const normalized = await normalizeLmsRequestBody(body, "openai");
const json = JSON.stringify(normalized);

assert.equal(
    normalized.model,
    "ri.language-model-service..language-model.gpt-5-6-terra",
);
assert.equal(json.includes('"type":"input_file"'), false);
assert.equal(json.includes('"type":"input_image"'), true);
assert.equal(json.includes("regression.pdf"), true);
assert.equal(json.match(/"type":"input_image"/g)?.length, 8);
assert.equal(json.includes('page 1 of 10'), true);
assert.equal(json.includes('page 10 of 10'), true);
assert.equal(imagePartCount(normalized), 8);
assert.equal("summary" in normalized.reasoning, false);
assert.equal("verbosity" in normalized.text, false);
assert.equal(normalized.tools[0].strict, false);
assert.deepEqual(normalized.tools[0].parameters, {
    type: "object",
    properties: {},
});

const oldOnlyBody = {
    model: "gpt-5.6-terra",
    input: [
        pdfMessage("old.pdf"),
        ...Array.from({ length: 32 }, (_, i) => textMessage(i)),
    ],
};
const oldOnlyNormalized = await normalizeLmsRequestBody(oldOnlyBody, "openai");
const oldOnlyJson = JSON.stringify(oldOnlyNormalized);
assert.equal(oldOnlyJson.includes('"type":"input_file"'), false);
assert.equal(imagePartCount(oldOnlyNormalized), 0);
assert.equal(oldOnlyJson.includes("Omitted older PDF attachment"), true);
assert.equal(oldOnlyJson.includes("Re-read the file"), true);

const duplicateBody = {
    model: "gpt-5.6-terra",
    input: [
        pdfMessage("old-duplicate.pdf"),
        ...Array.from({ length: 31 }, (_, i) => textMessage(i)),
        pdfMessage("new-duplicate.pdf"),
    ],
};
const duplicateNormalized = await normalizeLmsRequestBody(duplicateBody, "openai");
const duplicateJson = JSON.stringify(duplicateNormalized);
const duplicateText = inputTexts(duplicateNormalized).join("\n");
assert.equal(duplicateJson.includes('"type":"input_file"'), false);
assert.equal(imagePartCount(duplicateNormalized), 8);
assert.equal(duplicateJson.includes("old-duplicate.pdf"), true);
assert.equal(duplicateJson.includes("new-duplicate.pdf"), true);
assert.equal(duplicateText.includes('[PDF "old-duplicate.pdf" page'), false);
assert.equal(duplicateText.includes('[PDF "new-duplicate.pdf" page'), true);

console.log("lms-responses-compat regression passed");
