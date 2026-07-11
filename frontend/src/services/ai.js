// Shared request headers. OpenRouter recommends identifying the calling app.
const OR_HEADERS = (apiKey) => ({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Title": "AI Bookmark Organizer"
});

// Robustly pull a JSON object out of a model response that may include
// markdown fences, leading prose, or trailing junk. Throws if no object found.
function extractJson(content) {
    let text = (content || "").trim();

    // Strip markdown code fences if present
    if (text.includes("```")) {
        text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    }

    // Slice from the first "{" to the last "}" — drops any prose around it
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
        text = text.slice(start, end + 1);
    }

    try {
        return JSON.parse(text);
    } catch (firstErr) {
        // Models sometimes emit raw control characters inside string values
        // (e.g. a literal newline echoed from a bookmark title), which is
        // invalid JSON. Replacing every control character with a space is
        // safe: between tokens it is already whitespace, and inside a string
        // it repairs the bad literal without losing surrounding text.
        // eslint-disable-next-line no-control-regex
        const repaired = text.replace(/[\u0000-\u001F]/g, " ");
        try {
            return JSON.parse(repaired);
        } catch {
            throw firstErr;
        }
    }
}

// Determine if an error is retryable (transient) vs permanent
function isRetryableError(error, statusCode) {
    // Explicitly flagged (e.g. malformed/truncated model output): the request
    // succeeded but the response was unusable — a fresh attempt may differ.
    if (error?.retryable) return true;

    if (!statusCode) {
        // Network/timeout errors are retryable
        const message = error?.message || '';
        return message.includes('timeout') || message.includes('network') || message.includes('fetch');
    }

    // Retryable HTTP status codes:
    // 429 = Rate Limited, 500 = Server Error, 502 = Bad Gateway, 503 = Service Unavailable, 504 = Gateway Timeout
    return [429, 500, 502, 503, 504].includes(statusCode);
}

// Validate a completion response and extract its JSON payload. Throws errors
// that name the actual problem (empty / truncated / invalid JSON) and marks
// them retryable, since a fresh generation may well succeed.
function parseModelResponse(data) {
    const choice = data.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
        const error = new Error("model returned an empty response");
        error.retryable = true;
        throw error;
    }

    if (choice.finish_reason === 'length') {
        const error = new Error("model response was cut off at the max_tokens limit");
        error.retryable = true;
        throw error;
    }

    try {
        return extractJson(content);
    } catch (parseErr) {
        const error = new Error(`model returned invalid JSON (${parseErr.message})`);
        error.retryable = true;
        throw error;
    }
}

// The same single API-key field accepts keys from either provider. Google AI
// Studio keys start with "AIza"; everything else (OpenRouter "sk-or-...",
// OpenAI-style "sk-...") is treated as OpenRouter.
export function detectProvider(apiKey) {
    return (apiKey || '').trim().startsWith('AIza') ? 'gemini' : 'openrouter';
}

// Model ids in the UI are OpenRouter-namespaced ("google/gemini-3.1-flash-lite").
// The native Gemini API wants the bare id ("gemini-3.1-flash-lite").
function geminiModelId(model) {
    return model.replace(/^google\//, '');
}

// Validate a native Gemini generateContent response and extract its JSON
// payload, mirroring parseModelResponse: name the actual failure and mark it
// retryable so a fresh generation can succeed.
function parseGeminiResponse(data) {
    if (data.promptFeedback?.blockReason) {
        const error = new Error(`Gemini blocked the request (${data.promptFeedback.blockReason})`);
        throw error; // safety blocks are not transient — do not retry
    }

    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('');

    if (!content) {
        const error = new Error("model returned an empty response");
        error.retryable = true;
        throw error;
    }

    if (candidate.finishReason === 'MAX_TOKENS') {
        const error = new Error("model response was cut off at the max output token limit");
        error.retryable = true;
        throw error;
    }

    try {
        return extractJson(content);
    } catch (parseErr) {
        const error = new Error(`model returned invalid JSON (${parseErr.message})`);
        error.retryable = true;
        throw error;
    }
}

// Single model call routed to the right provider by key prefix. Returns the
// parsed JSON object. Throws errors tagged with statusCode/retryable so the
// shared withRetry wrapper can decide whether to back off and try again.
async function callModel(apiKey, model, systemContent, userContent, { temperature, maxTokens }) {
    if (detectProvider(apiKey) === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemContent }] },
                contents: [{ role: "user", parts: [{ text: userContent }] }],
                generationConfig: {
                    temperature,
                    maxOutputTokens: maxTokens,
                    responseMimeType: "application/json"
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            const error = new Error(`API Error: ${response.status} - ${errorText}`);
            error.statusCode = response.status;
            throw error;
        }

        return parseGeminiResponse(await response.json());
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: OR_HEADERS(apiKey),
        body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
                { role: "system", content: systemContent },
                { role: "user", content: userContent }
            ],
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`API Error: ${response.status} - ${errorText}`);
        error.statusCode = response.status;
        throw error;
    }

    return parseModelResponse(await response.json());
}

// Generic retry wrapper with exponential backoff
async function withRetry(fn, maxRetries = 3, initialDelayMs = 1000) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Extract status code if available
            const statusCode = error.statusCode || (error.message?.match(/(\d{3})/) ? parseInt(error.message.match(/(\d{3})/)[1]) : null);

            // If not retryable or this was the last attempt, throw
            if (!isRetryableError(error, statusCode) || attempt === maxRetries) {
                throw error;
            }

            // Calculate delay: 1s, 2s, 4s, 8s, etc.
            const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
            console.log(`Attempt ${attempt} failed, retrying in ${delayMs}ms:`, error.message);

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    throw lastError;
}

// Schema design only needs a representative spread of the collection, not every
// bookmark. Beyond this limit the prompt would blow past model context windows
// (e.g. 17k bookmarks ≈ several MB of prompt) and hang or fail the request.
export const SCHEMA_SAMPLE_LIMIT = 1000;

// Evenly spaced sample across the whole list. Bookmark exports are grouped by
// folder, so spacing preserves topic variety better than taking the first N.
function sampleForSchema(bookmarks) {
    if (bookmarks.length <= SCHEMA_SAMPLE_LIMIT) return bookmarks;
    const step = bookmarks.length / SCHEMA_SAMPLE_LIMIT;
    return Array.from({ length: SCHEMA_SAMPLE_LIMIT }, (_, i) => bookmarks[Math.floor(i * step)]);
}

export async function generateSchema(bookmarks, apiKey, baseCategories, model = "google/gemini-3.1-flash-lite", subfolderTarget = "5-10") {
    const subfolderRules = {
        '0-5': 'aim for roughly 3-5 sub-folders inside each category. Keep it minimal — only create subfolders for truly distinct groups. Err on the side of combining related items into broader folders.',
        '5-10': 'aim for roughly 5-10 sub-folders inside each category (about 7-8 is the sweet spot). Enough to be genuinely useful, few enough to scan at a glance. Scale to the content — a content-heavy category can carry more, a sparse one fewer.',
        '10+': 'aim for 10+ sub-folders inside each category where needed. Be generous with creating specific subfolders for different topics, ensuring each bookmark has a precise home.'
    };

    const subfolderGuidance = subfolderRules[subfolderTarget] || subfolderRules['5-10'];

    const schemaSource = sampleForSchema(bookmarks);
    const sampleNote = schemaSource.length < bookmarks.length
        ? `\n    NOTE: The list below is a representative sample of ${schemaSource.length} bookmarks drawn evenly from the full collection. Design the structure for the ENTIRE collection of ${bookmarks.length}.\n`
        : '';

    const prompt = `
    You are an expert information architect designing an intuitive bookmark folder structure for a real person's collection of ${bookmarks.length} bookmarks.
    ${sampleNote}

    GOAL
    Design a clean two-level structure: broad top-level CATEGORIES, each holding nested SUB-CATEGORIES. A person should glance at the folders and instantly know where any link lives — like a well-organized bookshelf, not a sprawling database.

    PREFERRED TOP-LEVEL CATEGORIES (a starting point — adapt to the actual bookmarks):
    ${JSON.stringify(baseCategories)}

    STRUCTURE RULES
    1. Top-level categories: aim for 8-10 broad, clearly distinct categories. Every bookmark must have a natural home.
    2. Sub-categories per category: ${subfolderGuidance}
    3. NON-REDUNDANCY IS CRITICAL. Sub-categories within a category MUST be mutually exclusive. Never create near-duplicates or synonyms as separate folders. Collapse "Tech News" + "Tech Articles" + "Tech Blogs" + "Tech Reports" into ONE folder. Collapse "Career Advice" + "Career Pathways" + "Career Roles" into ONE folder. Collapse "JS" + "JavaScript" into ONE. If two folder names could plausibly hold the same bookmark, merge them.
    4. Group by the user's INTENT, not surface keywords. Ask "why did they save this?" Links saved for the same purpose belong together even when their titles look different.

    NAMING RULES
    5. Use clear, human, real-world names a non-technical person understands. Prefer "Job Search" over "Career Acquisition Pipeline".
    6. Keep names short (1-3 words), in Title Case. No emojis, no numbering, no slashes.
    7. A folder's contents should be obvious from its name alone.

    QUALITY BAR
    8. No orphan folders: every sub-category should plausibly hold several bookmarks. Never create a folder for a single link — merge it into the nearest fit.
    9. Categories themselves must not overlap either. Each bookmark should have exactly ONE obvious destination, never two or three.
    10. Outliers that don't fit cleanly are fine — they belong in a "General" sub-folder or an "Other" category. Do NOT distort the structure to force-fit them.

    OUTPUT — return ONLY this JSON, no markdown fences, no commentary:
    {
      "categories": [
        {
          "name": "Category Name",
          "sub_categories": ["Subcategory A", "Subcategory B"]
        }
      ]
    }

    BOOKMARKS TO ANALYZE:
    ${JSON.stringify(schemaSource.map(b => ({ title: b.title, url: b.url })))}
    `;

    const systemContent = "You are an expert information architect and precise JSON generator. Output only valid JSON. Do not use Markdown blocks.";

    return await withRetry(() =>
        callModel(apiKey, model, systemContent, prompt, { temperature: 0.2, maxTokens: 8000 })
    );
}

export async function classifyBatch(bookmarks, apiKey, schema, model = "google/gemini-3.1-flash-lite") {
    const prompt = `
    Classify these ${bookmarks.length} bookmarks into the fixed folder structure below.

    APPROVED SCHEMA (the ONLY categories and sub-categories you may use):
    ${JSON.stringify(schema)}

    RULES
    1. For each bookmark, pick the single best-fitting category and sub_category, judging by the user's likely INTENT in saving it — not just keyword matching on the title.
    2. You MUST use category and sub_category strings EXACTLY as written in the schema above (same spelling, casing, spacing). Do not paraphrase or invent variants.
    3. If a bookmark fits a category but no sub-category within it, use "General" as the sub_category.
    4. If a bookmark fits no category at all, classify it as category "Other" with sub_category "General".
    5. Every bookmark must be classified exactly once. Refer to each bookmark ONLY by its index "i" — do NOT repeat titles or urls in your output.

    Return JSON object: { "classified": [ { "i": 0, "category": "...", "sub_category": "..." } ] }

    BOOKMARKS (each with its index "i"):
    ${JSON.stringify(bookmarks.map((b, i) => ({ i, title: b.title, url: b.url })))}
    `;

    const systemContent = "You are a precise classification engine and JSON generator. Output only valid JSON. Do not use Markdown blocks.";

    return await withRetry(async () => {
        const parsed = await callModel(apiKey, model, systemContent, prompt, { temperature: 0.1, maxTokens: 8000 });

        // Join the model's index-only answers back to the source bookmarks.
        // Titles and urls come from OUR data, never from model output — the
        // model can no longer mangle them, overflow max_tokens echoing long
        // urls, or corrupt the JSON with odd characters from titles. The
        // spread also carries fields the AI never sees (icon, add_date)
        // through to the export.
        const byIndex = new Map();
        for (const entry of parsed.classified || []) {
            if (Number.isInteger(entry.i) && entry.i >= 0 && entry.i < bookmarks.length && !byIndex.has(entry.i)) {
                byIndex.set(entry.i, entry);
            }
        }
        return bookmarks.map((b, i) => ({
            ...b,
            category: byIndex.get(i)?.category || 'Other',
            sub_category: byIndex.get(i)?.sub_category || 'General'
        }));
    });
}

