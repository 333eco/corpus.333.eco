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
import { fileURLToPath } from "node:url";

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

if (!ok) process.exit(1);

const tools = (L[2]?.tools ?? []).map((t) => t.name).sort();
console.log(`check-parity: both surfaces answered identically — ${tools.length} tools (${tools.join(", ")});`);
console.log(`              capabilities ${Object.keys(L[1].capabilities).sort().join(", ")}; ` +
            `${(L[3]?.prompts ?? []).length} prompts; protocol ${L[1].protocolVersion}`);
