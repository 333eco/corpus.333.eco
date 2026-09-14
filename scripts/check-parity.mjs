#!/usr/bin/env node
// Do the two surfaces answer the same way?
//
// ⭐ WHY THIS EXISTS. worker.mjs opens by claiming "Same tools, same provenance
// envelope, same refusal to summarise as the local stdio server one directory up."
// That was true and entirely unenforced: the two files kept separate TOOLS arrays,
// so the claim held only for as long as someone remembered it.
//
// ⚠️⚠️ IT USED TO READ SOURCE TEXT, AND THAT WAS TWO BUGS AND A BLIND SPOT.
// It regexed the files for `^\s{8}name: "…"`, brace-matched `capabilities: {`,
// and `^\s{4}"method/name":`. Consequences, all of them recorded in its own
// comments before this rewrite:
//
//   1. It was COUPLED TO INDENTATION. Moving a tool one nesting level, or
//      running a formatter, made tools invisible to it.
//   2. It silently dropped to reporting THREE tools when the base definitions
//      moved into a shared module — and it PASSED, because a parity checker that
//      under-reports agrees with itself.
//   3. Its capabilities regex stopped at the first nested `}`, so three
//      capabilities read as two.
//   4. It never compared INPUT SCHEMAS at all, so an argument added to one
//      surface only — exactly what happened when `voice` landed — would pass.
//
// ⛔⛔ (2) IS THE ONE THAT MATTERS AND IT WAS NEVER FIXED, only patched: adding
// the shared files to the scan list cured that instance and left the class open.
// A PURE DIFFERENCE TEST CANNOT CATCH A FAILURE THAT HITS BOTH SURFACES
// SYMMETRICALLY. So this version does two things instead of one:
//
//   • it DRIVES both servers with real JSON-RPC and deep-compares the answers,
//     which makes input schemas, annotations and prompt arguments free rather
//     than four more hand-written comparisons; and
//   • it asserts ABSOLUTES — a minimum tool count and the known core names — so
//     "both surfaces returned almost nothing" fails instead of passing.
//
// ⚠️ Descriptions of serverInfo and instructions legitimately differ between the
// surfaces and are not compared. Tool descriptions ARE compared: since 2026-09
// their facet enumerations are derived from the same pinned corpus, so a
// difference there means the two are serving different data.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = resolve(HERE, "..");

// The handshake plus every discovery method a client uses to learn what a server
// can do. `initialize` first, because both surfaces gate on protocol version.
const CALLS = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-parity", version: "1" } } },
    { id: 2, method: "tools/list" },
    { id: 3, method: "prompts/list" },
    { id: 4, method: "resources/templates/list" }
];

/* ------------------------------------------------------------------ stdio --- */

async function askStdio() {
    const child = spawn("node", [join(BASE, "src", "server.mjs")], {
        stdio: ["pipe", "pipe", "inherit"]
    });
    const out = [];
    child.stdout.on("data", (b) => out.push(b));
    for (const c of CALLS) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...c }) + "\n");
    child.stdin.end();
    await new Promise((ok, no) => {
        child.on("exit", ok);
        child.on("error", no);
    });
    const byId = {};
    for (const line of Buffer.concat(out).toString().split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id) byId[m.id] = m.result;
    }
    return byId;
}

/* ----------------------------------------------------------------- worker --- */
//
// In-process rather than through wrangler: the worker is a plain ES module whose
// only binding is ASSETS, and the asset it fetches is the corpus this repo just
// built. Stubbing that is honest — it is the same file the deployed worker is
// pinned to — and it keeps the check runnable in CI with no network.

async function askWorker() {
    const mod = await import(join(BASE, "worker", "src", "worker.mjs"));
    const corpus = await readFile(join(BASE, "dist", "corpus.json"), "utf8");
    const env = {
        ASSETS: { fetch: async () => new Response(corpus, { status: 200 }) }
    };
    const ctx = { waitUntil() {} };
    const byId = {};
    for (const c of CALLS) {
        const res = await mod.default.fetch(
            new Request("https://corpus.333.eco/mcp", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", ...c })
            }),
            env,
            ctx
        );
        const body = await res.json();
        byId[c.id] = body.result;
    }
    return byId;
}

/* ---------------------------------------------------------------- compare --- */

const stable = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort ? undefined : undefined);
const sortByName = (a) => [...(a ?? [])].sort((x, y) => x.name.localeCompare(y.name));

let ok = true;
const fail = (what, why) => {
    ok = false;
    console.error(`check-parity: ${what}`);
    if (why) console.error(`  ${why}`);
};

const [L, R] = await Promise.all([askStdio(), askWorker()]);

// ── absolutes, first ────────────────────────────────────────────────────────
// ⛔ THE POINT OF THIS SECTION. Everything below it is a difference test, and a
// difference test is blind to a failure that lands on both surfaces at once —
// which is precisely what happened when this file quietly began reporting three
// tools. These assertions are about the WORLD, not about agreement.
const CORE_TOOLS = ["search_corpus", "get_document", "list_documents"];
for (const [label, r] of [["stdio", L], ["worker", R]]) {
    const names = (r[2]?.tools ?? []).map((t) => t.name);
    if (names.length < CORE_TOOLS.length)
        fail(`${label} advertises ${names.length} tools`, "Fewer than the base set. A checker that under-reports passes; this is the guard against that.");
    for (const n of CORE_TOOLS)
        if (!names.includes(n)) fail(`${label} is missing the ${n} tool`);
    if (!r[1]?.capabilities?.tools) fail(`${label} does not declare the tools capability`);
    if (!(r[4]?.resourceTemplates ?? []).length) fail(`${label} advertises no resource template`);
}

// ── agreement ───────────────────────────────────────────────────────────────
const checks = [
    ["declared capabilities", Object.keys(L[1]?.capabilities ?? {}).sort(), Object.keys(R[1]?.capabilities ?? {}).sort(),
     "A capability declared on one surface only makes the other look less able than it is — or promises what it cannot do."],
    ["protocol version", [L[1]?.protocolVersion], [R[1]?.protocolVersion],
     "A client negotiates on this; two answers means two different servers."],
    ["tools", sortByName(L[2]?.tools), sortByName(R[2]?.tools),
     "Names, descriptions, annotations and INPUT SCHEMAS. A client picks a tool by name and calls it by schema, so an argument on one surface only fails only in production."],
    ["prompts", sortByName(L[3]?.prompts), sortByName(R[3]?.prompts),
     "Including argument names: a prompt argument that exists on one surface is a client error on the other."],
    ["resource templates", sortByName(L[4]?.resourceTemplates), sortByName(R[4]?.resourceTemplates),
     "The URI template is how a client addresses every document."]
];

for (const [label, a, b, why] of checks) {
    const A = JSON.stringify(a, null, 1);
    const B = JSON.stringify(b, null, 1);
    if (A === B) continue;
    fail(`the two surfaces do not agree on ${label}.`, why);
    // Name the first differing entry rather than printing two large blobs.
    const al = Array.isArray(a) ? a : [];
    const bl = Array.isArray(b) ? b : [];
    const names = [...new Set([...al, ...bl].map((x) => x?.name ?? String(x)))];
    for (const n of names) {
        const x = JSON.stringify(al.find((i) => (i?.name ?? String(i)) === n) ?? null, null, 1);
        const y = JSON.stringify(bl.find((i) => (i?.name ?? String(i)) === n) ?? null, null, 1);
        if (x !== y) {
            console.error(`  first difference: ${n}`);
            console.error(`    stdio : ${x?.slice(0, 400)}`);
            console.error(`    worker: ${y?.slice(0, 400)}`);
            break;
        }
    }
}

/* ------------------------------------------------------------- tool calls ---
   ⭐ THE ADVERTISEMENTS AGREEING SAYS NOTHING ABOUT THE ANSWERS. Dispatch is written
   twice — once per surface — so the same call is made on both and the RESULTS are
   compared. Then read_documents is held to absolutes, because paging is the kind of
   code that loses a document at a page boundary on both surfaces at once. */


const corpusText = await readFile(join(BASE, "dist", "corpus.json"), "utf8");
const corpusJson = JSON.parse(corpusText);
const letter = corpusJson.documents.find((d) => d.category === "letters")?.slug;

// A fresh module instance per corpus: the worker memoises its corpus per isolate,
// and an import is cached, so a tampered corpus needs its own copy of the module.
let instance = 0;
async function workerOver(text) {
    const mod = await import(pathToFileURL(join(BASE, "worker", "src", "worker.mjs")).href + `?i=${++instance}`);
    const env = { ASSETS: { fetch: async () => new Response(text, { status: 200 }) } };
    let id = 100;
    return async (method, params) => {
        const res = await mod.default.fetch(
            new Request("https://corpus.333.eco/mcp", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
            }),
            env,
            { waitUntil() {} }
        );
        return res.json();
    };
}

async function stdioAnswers(calls) {
    const child = spawn("node", [join(BASE, "src", "server.mjs")], { stdio: ["pipe", "pipe", "ignore"] });
    const out = [];
    child.stdout.on("data", (b) => out.push(b));
    calls.forEach((c, i) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }) + "\n"));
    child.stdin.end();
    await new Promise((done) => child.on("exit", done));
    const byId = {};
    for (const line of Buffer.concat(out).toString().split("\n")) if (line.trim()) { const m = JSON.parse(line); byId[m.id] = m; }
    return calls.map((_, i) => byId[i + 1]);
}

const tool = (name, args) => ({ method: "tools/call", params: { name, arguments: args } });
const SAME = [
    ["search_corpus, folded", tool("search_corpus", { query: "metta", limit: 3 })],
    ["search_corpus, a miss", tool("search_corpus", { query: "no-such-term-anywhere zzqx" })],
    ["list_documents, filtered", tool("list_documents", { category: "letters" })],
    ["read_documents, a small page", tool("read_documents", { category: "letters", max_bytes: 20000 })],
    ["read_documents, unknown slug", tool("read_documents", { slugs: ["no-such-document"] })],
    ["get_document", tool("get_document", { slug: letter })],
    ["resources/read", { method: "resources/read", params: { uri: `corpus://${letter}` } }]
];
{
    const worker = await workerOver(corpusText);
    const left = await stdioAnswers(SAME.map(([, c]) => c));
    for (let i = 0; i < SAME.length; i++) {
        const right = await worker(SAME[i][1].method, SAME[i][1].params);
        if (JSON.stringify(left[i]?.result ?? left[i]?.error) !== JSON.stringify(right?.result ?? right?.error)) {
            fail(`the two surfaces answer ${SAME[i][0]} differently.`, "Same call, same pinned corpus: a different answer is a dispatch bug in one of them.");
        }
    }
}

// ── read_documents, absolutes ──
{
    const call = await workerOver(corpusText);
    const END = /\[END OF DOCUMENT — ([^\s·.]+)[^\]]*\]$/;
    // ⛔ Parsed from CONTENT, the way a Claude client's model receives it (2.4.2): the document tools
    // carry no structuredContent, because a Claude client shows its model only that part when present.
    const PAGE = /^\[PAGE — documents (\d+)–(\d+) of (\d+)\..*\]$/;
    const readAll = async (args) => {
        const slugs = [];
        let cursor;
        for (let pages = 0; pages < 500; pages++) {
            const r = (await call("tools/call", { name: "read_documents", arguments: { ...args, ...(cursor ? { cursor } : {}) } })).result;
            if (r.structuredContent) fail("read_documents carries structuredContent — a Claude client would show its model that and not the documents");
            const blocks = r.content.slice(0, -1);
            const pageText = r.content.at(-1)?.text ?? "";
            const page = pageText.match(PAGE);
            if (!page) { fail(`read_documents' last block is not a [PAGE …] line: ${pageText.slice(0, 120)}`); return slugs; }
            if (blocks.length !== Number(page[2]) - Number(page[1]) + 1) fail("read_documents returned a block count that does not match its [PAGE] line");
            const bytes = blocks.reduce((n, b) => n + Buffer.byteLength(b.text, "utf8"), 0);
            const max = args.max_bytes ?? 90000;
            if (bytes > max && !(blocks.length === 1 && /larger than max_bytes/.test(pageText))) fail(`a read_documents page is ${bytes} bytes against max_bytes ${max}`);
            for (const b of blocks) {
                const m = b.text.match(END);
                if (!b.text.startsWith("[PROVENANCE") || !m) fail("a read_documents block does not run from its provenance header to its [END OF DOCUMENT] line");
                else slugs.push(m[1]);
            }
            const next = pageText.match(/cursor "([^"]+)"/);
            if (!next) return slugs;
            cursor = next[1];
        }
        fail("read_documents never stopped paging");
        return slugs;
    };
    const listed = async (args) => (await call("tools/call", { name: "list_documents", arguments: args })).result.structuredContent;

    for (const args of [{}, { category: "institutional" }, { voice: "founder", max_bytes: 1000 }]) {
        const want = (await listed(args)).documents.map((d) => d.slug);
        const got = await readAll(args);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
            fail(`paging read_documents(${JSON.stringify(args)}) did not return exactly what list_documents lists`,
                 `${got.length} read vs ${want.length} listed, ${new Set(got).size} distinct — a document lost or repeated at a page boundary.`);
        }
    }
    const all = await listed({});
    if (all.count !== corpusJson.manifest.served || all.completeness?.served !== all.count) {
        fail(`list_documents counts ${all.count} and its completeness block ${all.completeness?.served}; the manifest serves ${corpusJson.manifest.served}`);
    }
    const stale = btoa("0.0.0-another-corpus:3");
    if (!(await call("tools/call", { name: "read_documents", arguments: { cursor: stale } })).result?.isError) {
        fail("a cursor from another corpus version was accepted", "Page 2 of a different corpus must be refused, not served.");
    }
    const gdr = (await call("tools/call", { name: "get_document", arguments: { slug: letter } })).result;
    if (gdr.structuredContent) fail("get_document carries structuredContent — a Claude client would show its model that and not the document (§the-text-never-arrived)");
    const gd = gdr.content[0].text;
    const rr = (await call("resources/read", { uri: `corpus://${letter}` })).result.contents[0].text;
    if (gd !== rr || !END.test(gd)) fail("get_document and resources/read do not return the same text ending at its [END OF DOCUMENT] line");
}

// ── search: the fold, and the line that points at reading (2.4.1) ──
{
    const call = await workerOver(corpusText);
    const search = async (query, limit) => (await call("tools/call", { name: "search_corpus", arguments: { query, ...(limit ? { limit } : {}) } })).result;
    // ⭐ Diacritics optional — the case whose answer is known: `metta` and `mettā` must find
    // the same documents, and `Tonle Sap` must reach the text that writes `Tonlé Sap`.
    const [plain, marked] = [await search("metta", 200), await search("mettā", 200)];
    const ids = (r) => r.structuredContent.results.map((x) => x.slug).sort().join(",");
    if (!marked.structuredContent.matches || ids(plain) !== ids(marked)) {
        fail(`search_corpus does not fold diacritics: "metta" matched ${plain.structuredContent.matches}, "mettā" ${marked.structuredContent.matches}`);
    }
    const tonle = await search("Tonle Sap");
    if (!tonle.structuredContent.matches || !tonle.structuredContent.results.some((r) => r.excerpt.includes("Tonlé"))) {
        fail('search_corpus("Tonle Sap") did not return the verbatim "Tonlé" excerpt', "Fold to match, serve verbatim: the excerpt must carry the corpus's own spelling.");
    }
    // ⛔ The fold must stay Latin-only: Khmer vowel signs are marks too, and stripping them
    // would make Khmer text match what it does not say.
    const { fold } = await import(pathToFileURL(join(BASE, "src", "search.mjs")).href);
    if (fold("ស្រី") !== "ស្រី" || fold("ākāśa") !== "akasa") fail("fold() strips the wrong marks — it must fold Latin diacritics and leave Khmer untouched");

    const broad = await search("Miss Aquarius", 3);
    const line = broad.content[0].text.split("\n").at(-1);
    if (broad.structuredContent.reading !== line) {
        fail("search_corpus's reading line is not in structuredContent too", "A Claude client shows its model only structuredContent, so a line in content alone reaches no Claude reader.");
    }
    const m = line.match(/^\[Showing (\d+) of (\d+) matching documents?, as excerpts\. To answer from the full texts, call read_documents with slugs (\[.*?\])/);
    if (!m || Number(m[1]) !== broad.structuredContent.returned || Number(m[2]) !== broad.structuredContent.matches ||
        m[3] !== JSON.stringify(broad.structuredContent.results.map((r) => r.slug))) {
        fail("search_corpus's text does not end with a [Showing …] line naming exactly the slugs it returned", `got: ${line.slice(0, 200)}`);
    }

    const letters = (await call("tools/call", { name: "list_documents", arguments: { category: "letters" } })).result.structuredContent;
    if (letters.read_with?.tool !== "read_documents" || JSON.stringify(letters.read_with.arguments) !== JSON.stringify({ category: "letters" })) {
        fail("list_documents does not point at read_documents with the filters it was given", JSON.stringify(letters.read_with));
    }
}

// ── the manifest refusal ──
// ⛔ Tested against the case whose answer is known: a corpus with one document removed
// and its manifest intact must not be served.
{
    const tampered = JSON.parse(corpusText);
    tampered.documents = tampered.documents.slice(1);
    const call = await workerOver(JSON.stringify(tampered));
    const r = await call("tools/call", { name: "list_documents", arguments: {} });
    if (!r.error || !/does not match its manifest/.test(r.error.message)) {
        fail("a corpus missing one of its manifest's documents was served", "The load-time manifest check did not fire.");
    }
}

if (!ok) process.exit(1);

const tools = (L[2]?.tools ?? []).map((t) => t.name).sort();
console.log(`check-parity: both surfaces answered identically — ${tools.length} tools (${tools.join(", ")});`);
console.log(`              capabilities ${Object.keys(L[1].capabilities).sort().join(", ")}; ` +
            `${(L[3]?.prompts ?? []).length} prompts; protocol ${L[1].protocolVersion}`);
