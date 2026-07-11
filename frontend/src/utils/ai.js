/**
 * Classifies a batch of bookmarks using OpenRouter API.
 * @param {Array} batch - Array of bookmark objects.
 * @param {string} apiKey - The OpenRouter API Key.
 * @returns {Promise<Object>} - The JSON response with classified bookmarks.
 */
export const classifyBatch = async (batch, apiKey) => {
    const categories = [
        "Computer Science & Algorithms", "Web Development", "Data Science & AI",
        "Cybersecurity", "Finance & Trading", "Cloud & DevOps",
        "Tools & Utilities", "Career & Education", "Entertainment", "Other"
    ];

    const prompt = `
    Classify these ${batch.length} bookmarks.
    Categories: ${JSON.stringify(categories)}
    
    Return JSON object: { "classified": [ {title, url, category, sub_category, add_date, icon} ] }
    PRESERVE ALL FIELDS.
    
    Bookmarks:
    ${JSON.stringify(batch)}
    `;

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/n1ecC/Bookmark-Organizer-Browser-Extension", // Optional for OpenRouter
                "X-Title": "Bookmark Organizer Extension"
            },
            body: JSON.stringify({
                model: "google/gemini-3.5-flash",
                messages: [
                    { role: "system", content: "You are a precise JSON generator. Output only valid JSON. Do not use Markdown blocks." },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`API Error: ${response.status} - ${err}`);
        }

        const data = await response.json();
        let content = data.choices[0].message.content;

        // Clean markdown if present
        if (content.includes("```")) {
            content = content.replace(/```json/g, "").replace(/```/g, "");
        }

        return JSON.parse(content.trim());
    } catch (error) {
        console.error("Batch classification failed", error);
        throw error;
    }
};
