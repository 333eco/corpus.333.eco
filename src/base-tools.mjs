// The three base tools, shared by both surfaces.
//
// ⭐ Definitions are shared; DISPATCH is not. `callTool` takes different arguments
// on each surface (the worker is handed the corpus per request, the stdio server
// closes over it) and those functions are genuinely different code. What must
// never differ is what the two servers ADVERTISE — a client picks a tool by name
// and schema, so a drifted definition is a client calling something that isn't
// there. The envelope stays duplicated on purpose; that one is twenty lines and
// diffable by eye.

// ⭐⭐ EVERY TOOL HERE IS READ-ONLY, AND SAYING SO IS NOT DECORATION. A client that
// knows a call cannot mutate anything can stop putting a confirmation dialog in
// front of a corpus lookup. This server has no write path at all: it opens exactly
// one file, dist/corpus.json, and never writes.
// ⚠️ `openWorldHint: false` is the honest value — the corpus is a closed, fixed
// set for the life of a build, not an open-ended external system.
export const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

export const BASE_TOOLS = [
    {
        name: "search_corpus",
        title: "Search the corpus",
        annotations: { ...READ_ONLY, title: "Search the corpus" },
        description:
            "Full-text search across the open-licensed corpus. Returns matching documents with a provenance envelope " +
            "and a short excerpt around each match — not the full text; call get_document for that. Every result can " +
            "be independently verified via its sha256, DOI and OpenTimestamps proof.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to search for. Case-insensitive." },
                genre: { type: "string", description: "Optional: restrict to a genre, e.g. essays, defensive-publications, positions, white-papers." },
                limit: { type: "number", description: "Maximum documents to return. Default 10." }
            },
            required: ["query"]
        }
    },
    {
        name: "get_document",
        title: "Read one document in full",
        annotations: { ...READ_ONLY, title: "Read one document in full" },
        description:
            "Return one document in full, with its provenance envelope. The text is the canonical source — never a " +
            "summary — so its sha256 can be checked against the envelope and against the anchored proof.",
        inputSchema: {
            type: "object",
            properties: { slug: { type: "string", description: "Document slug, as returned by search_corpus or list_documents." } },
            required: ["slug"]
        }
    },
    {
        name: "list_documents",
        title: "List the corpus",
        annotations: { ...READ_ONLY, title: "List the corpus" },
        description:
            "List the corpus: slugs, titles, genres, licences and provenance summaries, without full text. Use to " +
            "orient before searching, or to enumerate what is available under a given licence.",
        inputSchema: {
            type: "object",
            properties: {
                genre: { type: "string", description: "Optional: restrict to a genre." },
                category: { type: "string", description: "Optional: restrict to a topic category. The response lists every category with its count." },
                voice: { type: "string", description: "Optional: restrict by whose voice a document is in." },
                licence: { type: "string", description: "Optional: restrict to a licence id, e.g. CC0-1.0 or CC-BY-4.0." }
            }
        }
    }
];


// ── the facet enumerations, DERIVED ─────────────────────────────────────────
//
// ⚠️ THEY WERE TYPED INTO THE DESCRIPTIONS ABOVE. `list_documents` listed its own
// genres and categories in prose — "essays, defensive-publications, positions,
// white-papers, letters, program" — in a file nothing checks, read by agents that
// act on it. Adding the `about` genre and the `voice` axis would have made two of
// them wrong on the same day.
//
// ⭐ So the values come from the artifact being served. Both surfaces load the
// same pinned corpus, so they cannot disagree, and a facet that gains a value
// gains it in the description at the same moment it gains it in the data.
//
// ⚠️ The hand-written GLOSSES stay: "institutional" is worth explaining and no
// count can explain it. A value with no gloss degrades to its bare name rather
// than disappearing, which is the failure mode worth avoiding — an enumeration
// that silently omits a value is worse than one with a terse entry.
const GLOSS = {
    institutional: "the four-body architecture and the institution itself",
    founder: "Thon Ly's own voice",
    collaborative: "the research corpus, disclosed as co-authored with Miss Aquarius\u2120",
    "defensive-publications": "prior-art publications",
    program: "the research programme and its register"
};

const enumerate = (values) =>
    values
        .map((v) => (GLOSS[v] ? `${v} (${GLOSS[v]})` : v))
        .join(", ");

/**
 * Fill `list_documents`' facet enumerations from the corpus this server serves.
 * Everything else is passed through untouched.
 */
export function withFacets(tools, corpus) {
    if (!corpus || !Array.isArray(corpus.documents)) return tools;
    const uniq = (key) =>
        [...new Set(corpus.documents.map((d) => d[key]).filter(Boolean))].sort();
    const genres = uniq("genre");
    const categories = uniq("category");
    const voices = Object.keys(corpus.voices || {}).sort();

    return tools.map((t) => {
        if (t.name !== "list_documents") return t;
        const props = { ...t.inputSchema.properties };
        if (genres.length)
            props.genre = { ...props.genre, description: `Optional: restrict to a genre — ${enumerate(genres)}.` };
        if (categories.length)
            props.category = { ...props.category, description: `Optional: restrict to a topic category — ${enumerate(categories)}. The response lists every category with its count.` };
        if (voices.length)
            props.voice = { ...props.voice, description: `Optional: restrict by whose voice a document is in — ${enumerate(voices)}. Orthogonal to genre and category.` };
        return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
    });
}
