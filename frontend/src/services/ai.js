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

// Short, human-readable label for common HTTP status codes so the log/UI
// says what actually went wrong instead of echoing a provider error blob.
const STATUS_LABELS = {
    400: "bad request (the model may have rejected the prompt)",
    401: "invalid or missing API key",
    402: "insufficient credits on your account",
    403: "access denied for this API key or model",
    404: "model not found",
    408: "the request timed out",
    413: "request too large — try a smaller batch",
    429: "rate limited — too many requests",
    500: "provider server error",
    502: "provider is unavailable (bad gateway)",
    503: "provider is temporarily overloaded",
    504: "provider timed out (gateway timeout)"
};

// Turn a raw API error response into one concise sentence. Providers return a
// full JSON body (OpenRouter and Gemini both nest the useful text under
// `error.message`); dumping the whole thing floods the terminal, so we pull
// out just the message and pair it with a friendly status label.
function summarizeApiError(response, errorText) {
    const status = response?.status || 500;
    const label = STATUS_LABELS[status] || `request failed (HTTP ${status})`;

    let detail = "";
    try {
        const body = JSON.parse(errorText);
        detail = body?.error?.message || body?.message || "";
    } catch {
        // Not JSON (e.g. an HTML gateway page) — fall back to the raw text.
        detail = (errorText || "").trim();
    }

    // Collapse whitespace and cap the length so a stray verbose message can't
    // recreate the exact "wall of JSON" problem we're fixing.
    detail = detail.replace(/\s+/g, " ").trim();
    if (detail.length > 160) detail = detail.slice(0, 157) + "…";

    const error = new Error(detail ? `${label} — ${detail}` : label);
    error.statusCode = status;

    if (response?.headers?.get) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) {
            error.retryAfterMs = retryAfter * 1000;
        }
    }

    return error;
}

// Determine if an error is retryable (transient) vs permanent
function isRetryableError(error, statusCode) {
    // Explicitly flagged (e.g. malformed/truncated model output): the request
    // succeeded but the response was unusable — a fresh attempt may differ.
    if (error?.retryable) return true;

    const message = (error?.message || '').toLowerCase();
    if (message.includes('rate') || message.includes('quota')) return true;

    if (!statusCode) {
        // Network/timeout errors are retryable
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
const REQUEST_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Single model call routed to the right provider by key prefix. Returns the
// parsed JSON object. Throws errors tagged with statusCode/retryable so the
// shared withRetry wrapper can decide whether to back off and try again.
async function callModel(apiKey, model, systemContent, userContent, { temperature, maxTokens }) {
    if (detectProvider(apiKey) === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetchWithTimeout(url, {
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
            throw summarizeApiError(response, await response.text());
        }

        return parseGeminiResponse(await response.json());
    }

    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
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
        throw summarizeApiError(response, await response.text());
    }

    return parseModelResponse(await response.json());
}

// Generic retry wrapper with exponential backoff, rate-limit cooldowns, jitter, Retry-After header support, and cancellation
export async function withRetry(fn, maxRetries = 5, initialDelayMs = 1500, isCancelled = null, onRetry = null) {
    let lastError;
    let attempt = 1;

    const checkCancelled = () => {
        if (!isCancelled) return false;
        return typeof isCancelled === 'function' ? isCancelled() : Boolean(isCancelled);
    };

    while (true) {
        if (checkCancelled()) {
            const err = new Error('Operation cancelled.');
            err.isCancelled = true;
            throw err;
        }

        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (error?.isCancelled) {
                throw error;
            }

            // Extract status code if available
            const statusCode = error.statusCode || (error.message?.match(/(\d{3})/) ? parseInt(error.message.match(/(\d{3})/)[1], 10) : null);
            const msgLower = (error?.message || '').toLowerCase();
            const isRateLimit = statusCode === 429 || msgLower.includes('rate') || msgLower.includes('quota');

            const maxAttempts = isRateLimit ? 8 : maxRetries;

            // If not retryable or this was the last attempt, throw
            if ((!isRetryableError(error, statusCode) && !isRateLimit) || attempt >= maxAttempts) {
                throw error;
            }

            let delayMs;
            if (isRateLimit) {
                const progressive = 5000 * Math.pow(1.8, attempt - 1) * (0.8 + Math.random() * 0.4);
                delayMs = (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0)
                    ? error.retryAfterMs
                    : Math.min(60000, progressive);
            } else {
                const exponentialDelay = initialDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
                delayMs = Math.min(30000, Math.max(exponentialDelay, error.retryAfterMs || 0));
            }

            console.log(`Attempt ${attempt} failed (${isRateLimit ? 'rate limit' : 'retryable'}), retrying in ${Math.round(delayMs)}ms:`, error.message);

            if (typeof onRetry === 'function') {
                try {
                    onRetry({ attempt, maxRetries: maxAttempts, delayMs, error: error.message || error, isRateLimit });
                } catch (cbErr) {
                    console.error('Error in onRetry callback:', cbErr);
                }
            }

            let elapsed = 0;
            const stepMs = 200;
            while (elapsed < delayMs) {
                if (checkCancelled()) {
                    const err = new Error('Operation cancelled.');
                    err.isCancelled = true;
                    throw err;
                }
                const sleepTime = Math.min(stepMs, delayMs - elapsed);
                await new Promise(resolve => setTimeout(resolve, sleepTime));
                elapsed += sleepTime;
            }

            if (checkCancelled()) {
                const err = new Error('Operation cancelled.');
                err.isCancelled = true;
                throw err;
            }

            attempt++;
        }
    }
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

export async function generateSchema(bookmarks, apiKey, baseCategories, model = "google/gemini-3.1-flash-lite", subfolderTarget = "5-10", isCancelled = null, onRetry = null) {
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

    return await withRetry(
        () => callModel(apiKey, model, systemContent, prompt, { temperature: 0.2, maxTokens: 8000 }),
        5,
        1500,
        isCancelled,
        onRetry
    );
}

export async function classifyBatch(bookmarks, apiKey, schema, model = "google/gemini-3.1-flash-lite", cleanTitles = false, isCancelled = null, onRetry = null) {
    const titleInstruction = cleanTitles
        ? `\n    6. Title cleanup: If clean_title is requested, provide a cleaned, human-readable title in the 'clean_title' field for each bookmark (strip site prefixes/suffixes like 'Login |', '- Wikipedia', query noise, or convert raw URL titles into clean titles). If the existing title is already clean, keep it as is.`
        : '';

    const returnSchema = cleanTitles
        ? '{ "classified": [ { "i": 0, "category": "...", "sub_category": "...", "clean_title": "..." } ] }'
        : '{ "classified": [ { "i": 0, "category": "...", "sub_category": "..." } ] }';

    const prompt = `
    Classify these ${bookmarks.length} bookmarks into the fixed folder structure below.

    APPROVED SCHEMA (the ONLY categories and sub-categories you may use):
    ${JSON.stringify(schema)}

    RULES
    1. For each bookmark, pick the single best-fitting category and sub_category, judging by the user's likely INTENT in saving it — not just keyword matching on the title.
    2. You MUST use category and sub_category strings EXACTLY as written in the schema above (same spelling, casing, spacing). Do not paraphrase or invent variants.
    3. If a bookmark fits a category but no sub-category within it, use "General" as the sub_category.
    4. If a bookmark fits no category at all, classify it as category "Other" with sub_category "General".
    5. Every bookmark must be classified exactly once. Refer to each bookmark ONLY by its index "i" — do NOT repeat titles or urls in your output.${titleInstruction}

    Return JSON object: ${returnSchema}

    BOOKMARKS (each with its index "i"):
    ${JSON.stringify(bookmarks.map((b, i) => ({ i, title: b.title, url: b.url })))}
    `;

    const systemContent = "You are a precise classification engine and JSON generator. Output only valid JSON. Do not use Markdown blocks.";

    return await withRetry(async () => {
        const parsed = await callModel(apiKey, model, systemContent, prompt, { temperature: 0.1, maxTokens: 8000 });

        // Join the model's index-only answers back to the source bookmarks.
        // Titles and urls come from OUR data, never from model output unless
        // cleanTitles is enabled and the model provides a valid clean_title.
        // The spread also carries fields the AI never sees (icon, add_date)
        // through to the export.
        const byIndex = new Map();
        for (const entry of parsed.classified || []) {
            if (Number.isInteger(entry.i) && entry.i >= 0 && entry.i < bookmarks.length && !byIndex.has(entry.i)) {
                byIndex.set(entry.i, entry);
            }
        }
        return bookmarks.map((b, i) => {
            const entry = byIndex.get(i);
            const hasCleanTitle = cleanTitles && typeof entry?.clean_title === 'string' && entry.clean_title.trim().length > 0;
            return {
                ...b,
                title: hasCleanTitle ? entry.clean_title.trim() : b.title,
                category: entry?.category || 'Other',
                sub_category: entry?.sub_category || 'General'
            };
        });
    }, 5, 1500, isCancelled, onRetry);
}

