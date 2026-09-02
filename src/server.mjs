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
import { RESOURCE_TEMPLATES, listResources, readResource, completeArgument } from "./resources.mjs";
import { structured, structuredWithText } from "./results.mjs";
import { provenanceHeader } from "./resources.mjs";
import { PROMPTS, getPrompt } from "./prompts.mjs";
import { BASE_TOOLS } from "./base-tools.mjs";
import { PROGRAM_TOOLS, PROGRAM_TOOL_NAMES, PROGRAM_INSTRUCTIONS, callProgramTool } from "./program-tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, "..", "dist", "corpus.json");

const log = (...a) => console.error("[corpus-mcp]", ...a);

if (!existsSync(INDEX)) {
    log("dist/corpus.json is missing. Build it: node scripts/build-index.mjs --from <corpus repos>");
    process.exit(1);
}

const corpus = JSON.parse(readFileSync(INDEX, "utf8"));
const bySlug = new Map(corpus.documents.map((d) => [d.slug, d]));
// The research program is optional: an index built over a corpus that does not
// contain it simply has no `program` block, and the three program tools are then
// not advertised at all. ⭐ An unadvertised tool is better than a tool that
// exists and always errors — a client can reason about the first.
const program = corpus.program ?? null;
log(`${corpus.document_count} documents loaded —`, JSON.stringify(corpus.licences));
if (program) log(`research program: ${program.prediction_count} predictions, ${program.reconciliation.reconciles ? "register arithmetic reconciles" : "⚠️ REGISTER ARITHMETIC DOES NOT RECONCILE"}`);

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

const TOOLS = BASE_TOOLS;

const KNOWN_TOOLS = new Set([...BASE_TOOLS, ...PROGRAM_TOOLS].map((t) => t.name));

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
        const readable = hits.length
            ? hits.map((h) => `${h.slug} — ${h.title}\n  ${h.excerpt}`).join("\n\n")
            : `no document matches "${q}".`;
        return structuredWithText(readable, { query: q, matches: hits.length, results: hits });
    }

    if (name === "get_document") {
        const d = bySlug.get(String(args?.slug ?? ""));
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

    if (name === "list_documents") {
        const list = corpus.documents
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
            count: list.length,
            licences: corpus.licences,
            // The shelves, so a caller can narrow without guessing the vocabulary.
            categories: corpus.documents.reduce((a, d) => ((a[d.category ?? "uncategorised"] = (a[d.category ?? "uncategorised"] ?? 0) + 1), a), {}),
            documents: list
        });
    }

    if (PROGRAM_TOOL_NAMES.includes(name)) {
        return callProgramTool({ program, bySlug, envelope }, name, args);
    }

    throw new Error(`unknown tool: ${name}`);
};

/* --------------------------------------------------------------- the loop --- */

const handlers = {
    initialize: (params) => ({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        // ⚠️ Declared because they are implemented. `subscribe`/`listChanged` are
        // deliberately absent: the corpus is fixed for the life of a build, so a
        // subscription would be a promise to send notifications that can never fire.
        capabilities: { tools: {}, resources: {}, completions: {}, prompts: {} },
        serverInfo: { name: "corpus.333.eco", version: corpus.package_version ?? "0.0.0-unbuilt" },
        instructions:
            "An open-licensed corpus served with verifiable provenance. Every document carries a sha256, and most " +
            "carry a DOI and an OpenTimestamps proof anchored in Bitcoin, so you can check any passage you intend to " +
            "cite rather than trusting this server. Documents under CC-BY carry attribute_to in their licence block; " +
            "honour it. Text is returned verbatim and is never summarised, because a summary cannot be hash-verified." +
            (program ? PROGRAM_INSTRUCTIONS : "")
    }),
    "tools/list": () => ({ tools: program ? [...TOOLS, ...PROGRAM_TOOLS] : TOOLS }),
    "resources/list": (params) => listResources(corpus.documents, params?.cursor),
    "resources/templates/list": () => ({ resourceTemplates: RESOURCE_TEMPLATES }),
    "resources/read": (params) => readResource(params?.uri, bySlug),
    "prompts/list": () => ({ prompts: PROMPTS }),
    "prompts/get": (params) => getPrompt(params?.name, params?.arguments),
    "completion/complete": (params) => completeArgument(params?.ref, params?.argument, corpus.documents),
    // ⛔ TWO KINDS OF FAILURE, AND THEY ARE NOT THE SAME KIND. An unknown tool is a
    // PROTOCOL error — the client asked for something that does not exist. A miss
    // INSIDE a known tool ("no document with that slug") is a tool-execution error,
    // and the spec puts those in the result with isError, not in a JSON-RPC error.
    // ⭐ The distinction is load-bearing here specifically because our failure
    // messages are GUIDANCE — "call list_documents to see what is available" — and
    // a protocol error frequently never reaches the model as recoverable context.
    // Returned as a result, the guidance is read and can be acted on; raised as
    // -32603 it was written for a reader who mostly would not see it.
    "tools/call": (params) => {
        const name = params?.name;
        if (!KNOWN_TOOLS.has(name)) throw new Error(`unknown tool: ${name}`);
        try {
            return callTool(name, params?.arguments);
        } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
        }
    }
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
