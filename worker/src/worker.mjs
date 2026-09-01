// The remote MCP server for the corpus — Cloudflare Workers.
//
// Same tools, same provenance envelope, same refusal to summarise as the local
// stdio server one directory up. What differs is the transport and where the
// corpus lives.
//
// ⭐ IT CONSUMES THE PUBLISHED PACKAGE, NOT THE CORPORA. scripts/sync.mjs copies
// dist/corpus.json out of an installed @333eco/corpus at an EXACT pinned version.
// That is the whole reason a second surface is safe to have: local and remote
// cannot disagree about what a document says, because they are the same bytes
// from the same tarball. A worker that re-read the source repositories would be
// a second opinion, and two opinions about a canonical text is one too many.
//
// ⚠️ THE CORPUS IS A STATIC ASSET, NOT A BUNDLED IMPORT. Gzipped it is 1.61 MB
// and a Worker script is capped at 1 MB compressed on the free plan, so importing
// it would fail to deploy — and would keep failing more as the corpus grows.
// Static Assets are served outside that budget. The worker fetches the corpus
// once per isolate and memoises it; subsequent requests in that isolate pay
// nothing. A cold isolate pays one same-datacenter fetch.
//
// ⚠️ TRANSPORT IS STREAMABLE HTTP, NOT THE OLD HTTP+SSE PAIR. A single endpoint
// takes POSTed JSON-RPC and answers with JSON. This server is stateless and
// read-only — no sessions, no server-initiated messages — so it never needs to
// upgrade a response to an SSE stream, and GET returns 405 rather than opening
// one that would carry nothing. Check the current MCP spec revision before
// adding either; the transport is the part of this file most likely to age.

const JSON_HEADERS = {
    "content-type": "application/json",
    // A public read-only endpoint. Browsers reach it from arbitrary origins and
    // there is nothing to protect: every byte served is already published under
    // an open licence at a canonical URL.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, mcp-protocol-version",
    "access-control-allow-methods": "POST, OPTIONS"
};

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Memoised per isolate. Cloudflare reuses an isolate across requests, so the
// 4.8 MB parse happens on cold start and not per request.
let corpusPromise = null;

const loadCorpus = (env) => {
    if (!corpusPromise) {
        corpusPromise = env.ASSETS.fetch(new Request("https://assets.local/corpus.json"))
            .then((r) => {
                if (!r.ok) throw new Error(`corpus.json asset returned ${r.status}`);
                return r.json();
            })
            .then((c) => ({ ...c, bySlug: new Map(c.documents.map((d) => [d.slug, d])) }))
            // A failed load must not be memoised, or one bad cold start poisons
            // the isolate for as long as it lives.
            .catch((e) => {
                corpusPromise = null;
                throw e;
            });
    }
    return corpusPromise;
};

/* ------------------------------------------------------------- the envelope ---
   Identical in shape to the stdio server's. Kept as its own function rather than
   imported so the two can be diffed by eye; if they ever disagree, that is a bug
   in one of them and the diff is where it shows. */

const envelope = (d) => ({
    slug: d.slug,
    title: d.title,
    licence: {
        id: d.licence.id,
        url: d.licence.url,
        attribution_required: d.licence.attribution_required,
        ...(d.licence.attribution_required && d.authors ? { attribute_to: d.authors } : {})
    },
    provenance: {
        ...d.provenance,
        verify: {
            // Concrete, because an instruction that says "the source file"
            // without saying which one is not an instruction. All three source
            // repositories are public, so this is genuinely runnable.
            sha256: d.provenance.source_url
                ? `curl -sL ${d.provenance.source_url} | shasum -a 256   # compare to provenance.sha256`
                : "shasum -a 256 <the source file>   # compare to provenance.sha256",
            ...(d.provenance.doi ? { doi: `https://doi.org/${d.provenance.doi}` } : {}),
            ...(d.provenance.opentimestamps
                ? { opentimestamps: `ots verify ${d.path}.ots   # in the source repository; anchored in the Bitcoin blockchain` }
                : {}),
            ...(d.provenance.deposited_matches_current === false
                ? {
                      note:
                          "Revised since its Zenodo deposit, so provenance.sha256 and provenance.deposited_sha256 " +
                          "differ legitimately. The DOI resolves to the deposited version; the text here is newer."
                  }
                : {})
        }
    }
});

const TOOLS = [
    {
        name: "search_corpus",
        description:
            "Full-text search across the open-licensed corpus. Returns matching documents with a provenance envelope " +
            "and a short excerpt around each match. Every result can be independently verified via its sha256, DOI " +
            "and OpenTimestamps proof.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to search for. Case-insensitive." },
                genre: { type: "string", description: "Optional: restrict to a genre." },
                limit: { type: "number", description: "Maximum documents to return. Default 10." }
            },
            required: ["query"]
        }
    },
    {
        name: "get_document",
        description:
            "Return one document in full, with its provenance envelope. The text is the canonical source — never a " +
            "summary — so its sha256 can be checked against the envelope and the anchored proof.",
        inputSchema: {
            type: "object",
            properties: { slug: { type: "string", description: "Document slug." } },
            required: ["slug"]
        }
    },
    {
        name: "list_documents",
        description: "List the corpus: slugs, titles, genres, licences and provenance summaries, without full text.",
        inputSchema: {
            type: "object",
            properties: {
                genre: { type: "string" },
                licence: { type: "string", description: "e.g. CC0-1.0 or CC-BY-4.0" }
            }
        }
    }
];

const asText = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

const excerpt = (body, query, span = 320) => {
    const i = body.toLowerCase().indexOf(query.toLowerCase());
    if (i === -1) return null;
    const from = Math.max(0, i - span / 2);
    return (from > 0 ? "…" : "") + body.slice(from, from + span).trim() + (from + span < body.length ? "…" : "");
};

const callTool = (corpus, name, args) => {
    if (name === "search_corpus") {
        const q = String(args?.query ?? "");
        if (!q) throw new Error("query is required");
        const results = corpus.documents
            .filter((d) => !args?.genre || d.genre === args.genre)
            .map((d) => ({ d, ex: excerpt(d.text, q) }))
            .filter((h) => h.ex !== null)
            .slice(0, Number(args?.limit ?? 10))
            .map((h) => ({ ...envelope(h.d), genre: h.d.genre, excerpt: h.ex }));
        return asText({ query: q, matches: results.length, results });
    }
    if (name === "get_document") {
        const d = corpus.bySlug.get(String(args?.slug ?? ""));
        if (!d) throw new Error(`no document with slug "${args?.slug}". Call list_documents to see what is available.`);
        return asText({
            ...envelope(d),
            genre: d.genre,
            repo: d.repo,
            path: d.path,
            metadata_convention: d.metadata_convention,
            // ⚠️ PRESENT ONLY WHERE THEY MEAN SOMETHING, and dropping them was a
            // real bug: `editorial` is what tells a consumer that the inline
            // [VERBATIM]/[SCAFFOLD] markers in `text` are a convention rather
            // than noise, and `segments` is the same split structurally. The
            // markers alone are the load-bearing half — they survive quotation —
            // but shipping them with nothing that explains them made the
            // convention look like an artefact of bad extraction.
            ...(d.editorial ? { editorial: d.editorial } : {}),
            ...(d.segments ? { segments: d.segments } : {}),
            text: d.text
        });
    }
    if (name === "list_documents") {
        const documents = corpus.documents
            .filter((d) => (!args?.genre || d.genre === args.genre) && (!args?.licence || d.licence.id === args.licence))
            .map((d) => ({ slug: d.slug, title: d.title, genre: d.genre, date: d.date, licence: d.licence.id, doi: d.provenance.doi, opentimestamps: d.provenance.opentimestamps }));
        return asText({ count: documents.length, licences: corpus.licences, documents });
    }
    throw new Error(`unknown tool: ${name}`);
};

const handlers = {
    initialize: (_corpus, params) => ({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "corpus.333.eco (remote)", version: "1.0.1" },
        instructions:
            "An open-licensed corpus served with verifiable provenance. Every document carries a sha256, and most " +
            "carry a DOI and an OpenTimestamps proof anchored in Bitcoin, so you can check any passage you intend to " +
            "cite rather than trusting this server. Documents under CC-BY carry attribute_to in their licence block; " +
            "honour it. Text is returned verbatim and is never summarised, because a summary cannot be hash-verified."
    }),
    "tools/list": () => ({ tools: TOOLS }),
    "tools/call": (corpus, params) => callTool(corpus, params?.name, params?.arguments)
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

        // A plain browser visit should explain itself rather than 404.
        if (request.method === "GET" && url.pathname !== "/mcp") {
            const corpus = await loadCorpus(env).catch(() => null);
            return new Response(
                JSON.stringify(
                    {
                        name: "corpus.333.eco",
                        transport: "MCP over Streamable HTTP",
                        endpoint: new URL("/mcp", url).toString(),
                        documents: corpus?.document_count ?? null,
                        licences: corpus?.licences ?? null,
                        local_equivalent: "npx @333eco/corpus",
                        source: "https://github.com/333eco/corpus.333.eco",
                        note: "Every response carries the document's sha256, DOI and OpenTimestamps status so you can verify what you were given."
                    },
                    null,
                    2
                ),
                { headers: JSON_HEADERS }
            );
        }

        // No sessions and no server-initiated messages, so there is nothing to
        // stream. Saying so is better than holding open a stream that never
        // carries anything.
        if (request.method === "GET") {
            return new Response(JSON.stringify({ error: "This server is stateless; it sends no server-initiated messages. POST JSON-RPC to /mcp." }), {
                status: 405,
                headers: { ...JSON_HEADERS, allow: "POST, OPTIONS" }
            });
        }

        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { ...JSON_HEADERS, allow: "POST, OPTIONS" } });
        }

        let msg;
        try {
            msg = await request.json();
        } catch {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }), { headers: JSON_HEADERS });
        }

        // Notifications carry no id and get 202 with no body, per the transport.
        if (msg.id === undefined) return new Response(null, { status: 202, headers: JSON_HEADERS });

        const handler = handlers[msg.method];
        if (!handler) {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }), { headers: JSON_HEADERS });
        }

        try {
            const corpus = await loadCorpus(env);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: handler(corpus, msg.params) }), { headers: JSON_HEADERS });
        } catch (e) {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } }), { headers: JSON_HEADERS });
        }
    }
};
