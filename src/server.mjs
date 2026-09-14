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
import { structured } from "./results.mjs";
import { envelope } from "./envelope.mjs";
import { PROMPTS, getPrompt } from "./prompts.mjs";
import { BASE_TOOLS, withFacets } from "./base-tools.mjs";
import { READ_TOOLS, READ_TOOL_NAMES, READ_INSTRUCTIONS, filterDocuments, readDocuments, getDocument, readWith, completenessOf, manifestProblems } from "./read-tools.mjs";
import { PROGRAM_TOOLS, PROGRAM_TOOL_NAMES, PROGRAM_INSTRUCTIONS, callProgramTool } from "./program-tools.mjs";
import { searchCorpus } from "./search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, "..", "dist", "corpus.json");

const log = (...a) => console.error("[corpus-mcp]", ...a);

// ⭐⭐ THE ONE NON-SERVING PATH, AND IT IS GUARDED BY BEING A SEPARATE MODULE.
// `--report-gap "<text>"` sends a voluntary note about something this corpus does
// not contain. It is a COMMAND, never telemetry: nothing here runs unless the
// flag is typed, and the reporter is loaded with a DYNAMIC IMPORT so the serving
// path does not so much as read the file off disk. ⛔ Never import report-gap.mjs
// at the top of this file — a static import would put a fetch in the module graph
// of every session, which is exactly the property this arrangement preserves.
// ⚠️ Handled before the index check on purpose: reporting a gap must not require
// a built corpus, since "there is no corpus here" is itself a reportable gap.
// ⭐ Both flags share ONE module and ONE dynamic import, so adding the second
// kind did not add a second way into the network. `--report-gap` says what the
// corpus is missing; `--report-bug` says what this server got wrong.
const REPORTS = { "--report-gap": "gap", "--report-bug": "bug" };
const flag = process.argv.find((a) => a in REPORTS);
if (flag) {
    const { report } = await import("./report.mjs");
    let version = null;
    try {
        version = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8")).version;
    } catch {
        // Version is a convenience for whoever reads the report, never required.
    }
    process.exit(await report(REPORTS[flag], process.argv[process.argv.indexOf(flag) + 1], version));
}

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
// ⛔ A CORPUS THAT DOES NOT MATCH ITS OWN MANIFEST IS NOT SERVED. Every envelope would
// still verify, which is exactly why a missing document could otherwise go unseen.
{
    const problems = manifestProblems(corpus);
    if (problems.length) {
        log("dist/corpus.json does not match its manifest — refusing to serve:\n  " + problems.join("\n  "));
        process.exit(1);
    }
}
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


/* -------------------------------------------------------------------- tools --- */

const TOOLS = [...BASE_TOOLS, ...READ_TOOLS];

const KNOWN_TOOLS = new Set([...TOOLS, ...PROGRAM_TOOLS].map((t) => t.name));

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });


const callTool = (name, args) => {
    if (name === "search_corpus") {
        // Shared with the other surface (search.mjs): the answer, the excerpts and the
        // reading line cannot differ between them.
        return searchCorpus({ documents: corpus.documents, envelope }, args);
    }

    if (name === "get_document") {
        // Shared (read-tools.mjs), and TEXT ONLY since 2.4.2 — see §the-text-never-arrived there.
        return getDocument({ bySlug: bySlug }, args);
    }
    if (name === "read_documents") {
        return readDocuments({ documents: corpus.documents, bySlug, version: String(corpus.package_version ?? "") }, args);
    }

    if (name === "list_documents") {
        // ⭐ The SAME filter read_documents applies (read-tools.mjs), so "read what I
        // just listed" cannot return a different set.
        const list = filterDocuments(corpus.documents, args)
            .map((d) => ({
                slug: d.slug,
                title: d.title,
                genre: d.genre,
                // ⭐ Carried in the index since the first build and exposed by
                // nothing until now. `institutional` is the four-body shelf,
                // `mechanism` the how-it-works shelf — the corpus already had a
                // topic taxonomy and no way to ask it a question.
                category: d.category,
                // ⭐ WHO IS SPEAKING, derived from genre in the builder rather
                // than stored per file. It is what makes "tell me about the
                // founder" one call instead of three.
                voice: d.voice,
                date: d.date,
                licence: d.licence.id,
                doi: d.provenance.doi,
                opentimestamps: d.provenance.opentimestamps,
                // A140: size before reading. Bytes and words, never tokens.
                bytes: d.bytes,
                words: d.words
            }));
        return structured({
            count: list.length,
            // For THIS filtered set — what reading it with read_documents would cost.
            total_bytes: list.reduce((n, d) => n + (d.bytes ?? 0), 0),
            total_words: list.reduce((n, d) => n + (d.words ?? 0), 0),
            licences: corpus.licences,
            // The shelves, so a caller can narrow without guessing the vocabulary.
            categories: corpus.documents.reduce((a, d) => ((a[d.category ?? "uncategorised"] = (a[d.category ?? "uncategorised"] ?? 0) + 1), a), {}),
            // Always the FULL count, never narrowed by the filter — a set of
            // documents means nothing without the honest denominator beside it,
            // the same reason list_predictions returns by_state unfiltered.
            ...(corpus.voices ? { voices: corpus.voices } : {}),
            // A87: the manifest's counts and reasons beside the listing they account for.
            ...(corpus.manifest ? { completeness: completenessOf(corpus) } : {}),
            // 2.4.1: what to call to read this listing in full — the same filters, as arguments.
            ...(readWith(args, list.length) ? { read_with: readWith(args, list.length) } : {}),
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
            READ_INSTRUCTIONS +
            (program ? PROGRAM_INSTRUCTIONS : "")
    }),
    // ⭐ withFacets fills list_documents' facet enumerations FROM THE CORPUS.
    // They used to be typed into the description and would have been wrong twice
    // over the day the `about` genre and the `voice` axis landed.
    "tools/list": () => ({
        tools: withFacets(program ? [...TOOLS, ...PROGRAM_TOOLS] : TOOLS, corpus)
    }),
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
