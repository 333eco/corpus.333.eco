#!/usr/bin/env node
//
// An MCP server over stdio for the open-licensed corpus.
//
//   npx @333eco/corpus            (or: node src/server.mjs)
//
// ⭐ WHAT MAKES THIS DIFFERENT FROM A DOCUMENT SERVER. Every response carries a
// PROVENANCE ENVELOPE — sha256, DOI, Zenodo record, whether an OpenTimestamps
// proof exists, and whether the current text still matches what was deposited.
// A retrieval server normally asks to be believed. This one hands over the means
// to check it, and the means are only worth anything because the anchors are
// already years old.
//
// The consequence for an agent citing this corpus: it can verify the passage it
// is about to quote instead of trusting the transport it arrived over.
//
// ⛔ THE LICENCE GATE IS UPSTREAM, IN THE INDEX. This file cannot serve an
// unlicensed document because build-index.mjs cannot put one in dist/corpus.json.
// That is deliberate — a gate in the request path is a rule that a future
// refactor can route around; a gate in the artifact is a property. Do not add a
// filesystem read here, ever: the moment this process can open a .md itself, the
// gate stops being structural.
//
// ⚠️ NO DEPENDENCIES, INCLUDING NO MCP SDK. MCP over stdio is newline-delimited
// JSON-RPC 2.0, which is a few hundred lines to speak correctly, and this estate's
// standing rule is node built-ins only. The cost is that protocol revisions have
// to be tracked by hand; PROTOCOL_VERSIONS below is where that lives.
//
// ⚠️ STDOUT IS THE PROTOCOL. Never console.log for diagnostics — a stray line
// corrupts the stream and the client fails with a parse error that names nothing.
// Diagnostics go to stderr, which clients surface as server logs.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, "..", "dist", "corpus.json");

const log = (...a) => console.error("[corpus-mcp]", ...a);

if (!existsSync(INDEX)) {
    log("dist/corpus.json is missing. Build it: node scripts/build-index.mjs --from <corpus repos>");
    process.exit(1);
}

const corpus = JSON.parse(readFileSync(INDEX, "utf8"));
const bySlug = new Map(corpus.documents.map((d) => [d.slug, d]));
log(`${corpus.document_count} documents loaded —`, JSON.stringify(corpus.licences));

/* ------------------------------------------------------- protocol plumbing ---
   Versions this server knows how to speak, newest first. On initialize the spec
   has the server answer with the version it WILL use: echo the client's if we
   know it, otherwise offer our newest and let the client decide. */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

/* ------------------------------------------------------------- the envelope ---
   Attached to every document a tool returns. `verify` is the instruction rather
   than a promise: it tells the agent exactly what to run, so the claim is
   checkable without trusting this sentence either. */

const envelope = (d) => ({
    slug: d.slug,
    title: d.title,
    licence: {
        id: d.licence.id,
        url: d.licence.url,
        attribution_required: d.licence.attribution_required,
        // Only present where it is actually owed, so an agent can act on the
        // field's presence rather than parsing the licence id.
        ...(d.licence.attribution_required && d.authors ? { attribute_to: d.authors } : {})
    },
    provenance: {
        ...d.provenance,
        verify: {
            sha256: `printf '%s' "$(cat <file>)" | shasum -a 256   # compare to provenance.sha256, computed over the FULL source file including its metadata block`,
            ...(d.provenance.doi ? { doi: `https://doi.org/${d.provenance.doi}` } : {}),
            ...(d.provenance.opentimestamps
                ? { opentimestamps: `ots verify ${d.path}.ots  # in the source repository; the proof is anchored in the Bitcoin blockchain` }
                : {}),
            ...(d.provenance.deposited_matches_current === false
                ? {
                      note:
                          "This document has been REVISED since its Zenodo deposit, so provenance.sha256 " +
                          "and provenance.deposited_sha256 differ legitimately. The DOI resolves to the " +
                          "deposited version; the text served here is newer. Cite accordingly."
                  }
                : {})
        }
    }
});

/* -------------------------------------------------------------------- tools --- */

const TOOLS = [
    {
        name: "search_corpus",
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
        description:
            "List the corpus: slugs, titles, genres, licences and provenance summaries, without full text. Use to " +
            "orient before searching, or to enumerate what is available under a given licence.",
        inputSchema: {
            type: "object",
            properties: {
                genre: { type: "string", description: "Optional: restrict to a genre." },
                licence: { type: "string", description: "Optional: restrict to a licence id, e.g. CC0-1.0 or CC-BY-4.0." }
            }
        }
    }
];

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

const excerpt = (body, query, span = 320) => {
    const i = body.toLowerCase().indexOf(query.toLowerCase());
    if (i === -1) return null;
    const from = Math.max(0, i - span / 2);
    return (from > 0 ? "…" : "") + body.slice(from, from + span).trim() + (from + span < body.length ? "…" : "");
};

const callTool = (name, args) => {
    if (name === "search_corpus") {
        const q = String(args?.query ?? "");
        if (!q) throw new Error("query is required");
        const limit = Number(args?.limit ?? 10);
        const hits = corpus.documents
            .filter((d) => !args?.genre || d.genre === args.genre)
            .map((d) => ({ d, ex: excerpt(d.text, q) }))
            .filter((h) => h.ex !== null)
            .slice(0, limit)
            .map((h) => ({ ...envelope(h.d), genre: h.d.genre, excerpt: h.ex }));
        return text({ query: q, matches: hits.length, results: hits });
    }

    if (name === "get_document") {
        const d = bySlug.get(String(args?.slug ?? ""));
        if (!d) throw new Error(`no document with slug "${args?.slug}". Call list_documents to see what is available.`);
        return text({ ...envelope(d), genre: d.genre, repo: d.repo, path: d.path, metadata_convention: d.metadata_convention, text: d.text });
    }

    if (name === "list_documents") {
        const list = corpus.documents
            .filter((d) => (!args?.genre || d.genre === args.genre) && (!args?.licence || d.licence.id === args.licence))
            .map((d) => ({
                slug: d.slug,
                title: d.title,
                genre: d.genre,
                date: d.date,
                licence: d.licence.id,
                doi: d.provenance.doi,
                opentimestamps: d.provenance.opentimestamps
            }));
        return text({ count: list.length, licences: corpus.licences, documents: list });
    }

    throw new Error(`unknown tool: ${name}`);
};

/* --------------------------------------------------------------- the loop --- */

const handlers = {
    initialize: (params) => ({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "corpus.333.eco", version: "1.0.0" },
        instructions:
            "An open-licensed corpus served with verifiable provenance. Every document carries a sha256, and most " +
            "carry a DOI and an OpenTimestamps proof anchored in Bitcoin, so you can check any passage you intend to " +
            "cite rather than trusting this server. Documents under CC-BY carry attribute_to in their licence block; " +
            "honour it. Text is returned verbatim and is never summarised, because a summary cannot be hash-verified."
    }),
    "tools/list": () => ({ tools: TOOLS }),
    "tools/call": (params) => callTool(params?.name, params?.arguments)
};

createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return failure(null, -32700, "parse error");
    }
    // Notifications carry no id and take no response — notifications/initialized
    // above all, which a client sends and which must not be answered.
    if (msg.id === undefined) return;

    const handler = handlers[msg.method];
    if (!handler) return failure(msg.id, -32601, `method not found: ${msg.method}`);
    try {
        result(msg.id, handler(msg.params));
    } catch (e) {
        failure(msg.id, -32603, e.message);
    }
});
