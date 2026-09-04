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

import { RESOURCE_TEMPLATES, listResources, readResource, completeArgument } from "../../src/resources.mjs";
import { structured, structuredWithText } from "../../src/results.mjs";
import { provenanceHeader } from "../../src/resources.mjs";
import { PROMPTS, getPrompt } from "../../src/prompts.mjs";
import { BASE_TOOLS } from "../../src/base-tools.mjs";
import { PROGRAM_TOOLS, PROGRAM_TOOL_NAMES, PROGRAM_INSTRUCTIONS, callProgramTool } from "../../src/program-tools.mjs";
import { clientOf, record, missOf, resultsOf, beacon } from "./telemetry.mjs";

// ⭐ THE PROGRAM TOOLS ARE IMPORTED, NOT COPIED — unlike the envelope below. The
// envelope is twenty lines and duplication makes it diffable; the tool surface is
// a hundred and twenty, and a hand-kept second copy is exactly how this endpoint
// would end up advertising tools the npm package does not have. Wrangler bundles
// JavaScript, so a shared module costs nothing here; only the corpus itself has
// to stay a static asset.

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
        // ⚠️ A LIVING DOCUMENT IS VERIFIED AND CITED WITH DIFFERENT DOIs, and
        // saying only "cite accordingly" leaves the reader to guess which.
        // The VERSION doi is the only one that can be true of the bytes here
        // — it pins them — so it is what a hash check resolves against. The
        // CONCEPT doi follows the document, so it is what a citation should
        // name: a living register is revised on purpose, and a citation
        // pinned to one revision goes stale by design rather than by accident.
        ...(d.status === "living" && d.provenance.concept_doi
            ? {
                  citation: {
                      cite: `https://doi.org/${d.provenance.concept_doi}`,
                      verify_against: d.provenance.doi ? `https://doi.org/${d.provenance.doi}` : null,
                      why: "This document is living — it is revised on purpose. Cite the concept DOI, which always resolves to the newest version; verify the text you were served against the version DOI and sha256 above, which pin these exact bytes."
                  }
              }
            : {}),
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

const TOOLS = BASE_TOOLS;

const KNOWN_TOOLS = new Set([...BASE_TOOLS, ...PROGRAM_TOOLS].map((t) => t.name));

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
        const readable = results.length
            ? results.map((h) => `${h.slug} — ${h.title}\n  ${h.excerpt}`).join("\n\n")
            : `no document matches "${q}".`;
        return structuredWithText(readable, { query: q, matches: results.length, results: results });
    }
    if (name === "get_document") {
        const d = corpus.bySlug.get(String(args?.slug ?? ""));
        if (!d) throw new Error(`no document with slug "${args?.slug}". Call list_documents to see what is available.`);
        // ⭐ The document goes to `content` WITH ITS PROVENANCE HEADER — the same
        // bytes resources/read returns, so the two doors into a document agree —
        // and the envelope goes to `structuredContent` WITHOUT the body. Split by
        // role; nothing is sent twice.
        return structuredWithText(provenanceHeader(d) + "\n\n" + d.text, {
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
            // ⚠️ Deliberately absent: the body is in `content`. Carrying it here
            // too is the duplication this shape exists to avoid.
            text_in: "content[0].text, prefixed by the provenance header"
        });
    }
    if (PROGRAM_TOOL_NAMES.includes(name)) {
        return callProgramTool(
            { program: corpus.program ?? null, bySlug: corpus.bySlug, envelope, asText },
            name,
            args
        );
    }
    if (name === "list_documents") {
        const documents = corpus.documents
            .filter((d) => (!args?.genre || d.genre === args.genre) &&
                    (!args?.licence || d.licence.id === args.licence) &&
                    (!args?.category || d.category === args.category))
            .map((d) => ({
                slug: d.slug,
                title: d.title,
                genre: d.genre,
                // ⭐ Carried in the index since the first build and exposed by
                // nothing until now. `institutional` is the four-body shelf,
                // `mechanism` the how-it-works shelf — the corpus already had a
                // topic taxonomy and no way to ask it a question.
                category: d.category,
                date: d.date,
                licence: d.licence.id,
                doi: d.provenance.doi,
                opentimestamps: d.provenance.opentimestamps
            }));
        return structured({
            count: documents.length,
            licences: corpus.licences,
            // The shelves, so a caller can narrow without guessing the vocabulary.
            categories: corpus.documents.reduce((a, d) => ((a[d.category ?? "uncategorised"] = (a[d.category ?? "uncategorised"] ?? 0) + 1), a), {}),
            documents: documents
        });
    }
    throw new Error(`unknown tool: ${name}`);
};

const handlers = {
    initialize: (_corpus, params) => ({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        // See the stdio server: subscribe/listChanged are omitted on purpose.
        capabilities: { tools: {}, resources: {}, completions: {}, prompts: {} },
        // ⭐ The version of the CORPUS PACKAGE this worker is pinned to, not of the
        // worker's own code — the honest answer for a surface built around an
        // exact pin, and the same number the stdio server reports for that build.
        serverInfo: { name: "corpus.333.eco (remote)", version: _corpus?.package_version ?? "0.0.0-unbuilt" },
        instructions:
            "An open-licensed corpus served with verifiable provenance. Every document carries a sha256, and most " +
            "carry a DOI and an OpenTimestamps proof anchored in Bitcoin, so you can check any passage you intend to " +
            "cite rather than trusting this server. Documents under CC-BY carry attribute_to in their licence block; " +
            "honour it. Text is returned verbatim and is never summarised, because a summary cannot be hash-verified." +
            (_corpus?.program ? PROGRAM_INSTRUCTIONS : "")
    }),
    // ⚠️ Takes the corpus, because whether the program tools exist depends on
    // whether the pinned package's index carries a program block.
    "tools/list": (corpus) => ({ tools: corpus?.program ? [...TOOLS, ...PROGRAM_TOOLS] : TOOLS }),
    "resources/list": (corpus, params) => listResources(corpus.documents, params?.cursor),
    "resources/templates/list": () => ({ resourceTemplates: RESOURCE_TEMPLATES }),
    "resources/read": (corpus, params) => readResource(params?.uri, corpus.bySlug),
    "prompts/list": () => ({ prompts: PROMPTS }),
    "prompts/get": (corpus, params) => getPrompt(params?.name, params?.arguments),
    "completion/complete": (corpus, params) => completeArgument(params?.ref, params?.argument, corpus.documents),
    // See the stdio server: an unknown tool is a protocol error, a miss inside a
    // known one is a tool-execution error whose message is guidance the model
    // should get back as readable context rather than as -32603.
    "tools/call": (corpus, params) => {
        const name = params?.name;
        if (!KNOWN_TOOLS.has(name)) throw new Error(`unknown tool: ${name}`);
        try {
            return callTool(corpus, name, params?.arguments);
        } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
        }
    }
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

        // A plain browser visit should explain itself rather than 404.
        if (request.method === "GET" && url.pathname !== "/mcp") {
            const corpus = await loadCorpus(env).catch(() => null);
            record(env, ctx, { client: clientOf(null, request), country: request.cf?.country ?? "", method: "GET", version: String(corpus?.package_version ?? "") });
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
                        note: "Every response carries the document's sha256, DOI and OpenTimestamps status so you can verify what you were given.",
                        // ⭐ SAID HERE BECAUSE THIS IS WHERE IT CAN BE READ. A
                        // privacy policy is a page someone has to go and find;
                        // this is the endpoint describing itself, in the one
                        // response a caller gets for free before doing anything.
                        // The disclosure travels with the thing it is about.
                        records: {
                            what: "Per-call counts: the JSON-RPC method, the tool, the document slug, the client software's own name from its handshake, and the country Cloudflare resolves. Search text is stored ONLY when a search matched nothing, because the reason to keep it is to learn what this corpus lacks.",
                            not: "No IP address, no identifier derived from one, no cookie, no per-caller id of any kind. Every user of a given client is one label. Successful search text is never written down.",
                            local: "npx @333eco/corpus records nothing and sends nothing. It runs on your machine and this does not apply to it."
                        }
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

        const started = Date.now();
        const client = clientOf(msg, request);
        const country = request.cf?.country ?? "";
        const rpcError = (m) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: m } }), { headers: JSON_HEADERS });

        // ⚠️ THE CORPUS LOAD IS ITS OWN TRY, AND THE SPLIT IS WHAT KEEPS THE
        // BEACON QUIET. A failed asset fetch is an outage worth a push; an
        // unknown tool name is a caller's mistake and worth a counter. Wrapped
        // together — as they were — every stranger probing for a tool that does
        // not exist would ring the same bell as the corpus going dark, and the
        // bell would stop meaning anything.
        let corpus;
        try {
            corpus = await loadCorpus(env);
        } catch (e) {
            record(env, ctx, { client, country, method: msg.method, errored: 1, ms: Date.now() - started });
            beacon(env, ctx, { event: "corpus_error", client, country, data: { method: String(msg.method ?? ""), message: String(e.message).slice(0, 200) } });
            return rpcError(e.message);
        }

        try {
            const result = handler(corpus, msg.params);
            const args = msg.params?.arguments;
            record(env, ctx, {
                client,
                country,
                method: String(msg.method ?? ""),
                tool: msg.method === "tools/call" ? String(msg.params?.name ?? "") : "",
                slug: String(args?.slug ?? msg.params?.uri ?? ""),
                protocol: String(msg.params?.protocolVersion ?? ""),
                version: String(corpus.package_version ?? ""),
                missedQuery: missOf(msg.params?.name, result),
                results: resultsOf(result),
                errored: result?.isError ? 1 : 0,
                ms: Date.now() - started
            });
            // The handshake is the session, so this fires once per connection
            // rather than once per call — and thonly.org pushes only the first
            // sighting of a client label, counting every one after it in silence.
            if (msg.method === "initialize") {
                beacon(env, ctx, {
                    event: "corpus_connect",
                    client,
                    country,
                    data: {
                        version: String(msg.params?.clientInfo?.version ?? ""),
                        protocol: String(msg.params?.protocolVersion ?? ""),
                        corpus: String(corpus.package_version ?? "")
                    }
                });
            }
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { headers: JSON_HEADERS });
        } catch (e) {
            // Counted, never pushed: a malformed request is the caller's problem.
            record(env, ctx, { client, country, method: String(msg.method ?? ""), errored: 1, ms: Date.now() - started });
            return rpcError(e.message);
        }
    }
};
