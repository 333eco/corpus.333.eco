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
                genre: { type: "string", description: "Optional: restrict to a genre — essays, defensive-publications, positions, white-papers, letters, program." },
                category: { type: "string", description: "Optional: restrict to a topic category — institutional (the four-body architecture and the institution itself), mechanism, alignment, essays, letters, program, capabilities. The response lists every category with its count." },
                licence: { type: "string", description: "Optional: restrict to a licence id, e.g. CC0-1.0 or CC-BY-4.0." }
            }
        }
    }
];
