#!/usr/bin/env node
// Do the two surfaces advertise the same tools?
//
// ⭐ WHY THIS EXISTS. worker.mjs opens by claiming "Same tools, same provenance
// envelope, same refusal to summarise as the local stdio server one directory up."
// That was true and entirely unenforced: the two files kept separate TOOLS arrays,
// so the claim held only for as long as someone remembered it. The research-program
// tools are now a shared module and cannot drift; the three base tools are still
// declared twice, deliberately, because they are short enough to diff by eye — and
// this turns "diff by eye" into something that actually runs.
//
// ⚠️ It compares NAMES, not descriptions: the two surfaces legitimately word their
// serverInfo and instructions differently. A missing or extra TOOL is the failure
// that matters, because a client discovers capability by name.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = resolve(HERE, "..");
const names = (file) => {
    const src = readFileSync(join(BASE, file), "utf8");
    // Tool declarations are `name: "…"` inside a TOOLS array; serverInfo's name
    // is `name: "corpus.333.eco…"`, excluded by requiring a snake_case identifier.
    return [...src.matchAll(/^\s{8}name: "([a-z][a-z0-9_]+)"/gm)].map((m) => m[1]).sort();
};

// ⚠️ Shared definitions count for BOTH surfaces. When the base tools moved into
// src/base-tools.mjs this check silently dropped to reporting three tools — a
// parity checker that under-reports is worse than none, because it passes.
const SHARED = ["src/base-tools.mjs", "src/program-tools.mjs"];
const local = [...names("src/server.mjs"), ...SHARED.flatMap(names)].sort();
const remote = [...names("worker/src/worker.mjs"), ...SHARED.flatMap(names)].sort();

// ⚠️ TOOLS WERE NEVER THE WHOLE SURFACE. A client discovers what a server can do
// from three places — the tool names, the declared capabilities, and the JSON-RPC
// methods actually routed. A server that lists a tool it cannot dispatch, or
// declares `resources` on one surface only, is broken in a way a tool-name diff
// cannot see.
// ⚠️ Brace-matched, not regex'd. `capabilities: { tools: {}, resources: {} }` is
// nested, and a character-class regex stopped at the first inner `}` — which read
// as "two capabilities" the moment a third was added, and would have reported
// parity while missing exactly the drift it exists to catch.
const capabilities = (file) => {
    const src = readFileSync(join(BASE, file), "utf8");
    const at = src.indexOf("capabilities: {");
    if (at < 0) return [];
    let depth = 0, end = at;
    for (let i = src.indexOf("{", at); i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    const inner = src.slice(src.indexOf("{", at) + 1, end);
    return [...inner.matchAll(/([a-z][a-zA-Z]*)\s*:\s*\{/g)].map((x) => x[1]).sort();
};
const methods = (file) => {
    const src = readFileSync(join(BASE, file), "utf8");
    return [...src.matchAll(/^\s{4}"([a-z]+\/[a-z/]+)":/gm)].map((m) => m[1]).sort();
};

const compare = (label, a, b, why) => {
    const onlyA = a.filter((n) => !b.includes(n));
    const onlyB = b.filter((n) => !a.includes(n));
    if (!onlyA.length && !onlyB.length) return true;
    console.error(`check-parity: the two surfaces do not agree on ${label}.`);
    if (onlyA.length) console.error(`  stdio only: ${onlyA.join(", ")}`);
    if (onlyB.length) console.error(`  worker only: ${onlyB.join(", ")}`);
    console.error(`  ${why}`);
    return false;
};

const ok = [
    compare("tools", local, remote, "A client discovers capability by name; a tool on one surface and not the other is a bug in one of them."),
    compare("declared capabilities", capabilities("src/server.mjs"), capabilities("worker/src/worker.mjs"),
        "A capability declared on one surface only makes the other look less able than it is — or promises what it cannot do."),
    compare("routed methods", methods("src/server.mjs"), methods("worker/src/worker.mjs"),
        "A method handled on one surface only fails as -32601 on the other, after the client has already been told the capability exists.")
].every(Boolean);

if (!ok) process.exit(1);
console.log(`check-parity: both surfaces agree — ${local.length} tools (${local.join(", ")});`);
console.log(`              capabilities ${capabilities("src/server.mjs").join(", ")}; methods ${methods("src/server.mjs").join(", ")}`);
