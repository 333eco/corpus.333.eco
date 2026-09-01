#!/usr/bin/env node
//
// Copies dist/corpus.json out of the INSTALLED @333eco/corpus into public/,
// where wrangler serves it as a static asset.
//
//   node scripts/sync.mjs            copy
//   node scripts/sync.mjs --check    fail if public/ is not the installed version
//
// ⭐ WHY IT COPIES FROM THE PACKAGE AND NOT FROM THE CORPORA. A remote surface
// that re-read the source repositories would be a SECOND OPINION about what a
// document says, and two opinions about a canonical text is one too many. The
// dependency is pinned to an exact version — no caret — so "which corpus is the
// worker serving" has one answer, and it is a version number anyone can install.
//
// ⚠️ --check IS THE CURRENCY GUARD, and it exists because this estate has already
// been bitten: four repositories once sat three versions behind a vendored layer
// with every guard reporting green, because integrity was checked and currency
// was not. Here the stakes are higher — a stale asset makes the worker serve
// superseded text WITH A VALID ENVELOPE, which an agent has no way to question.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = resolve(HERE, "..");
const DEST = join(BASE, "public", "corpus.json");

const die = (m) => {
    console.error(`sync: ${m}`);
    process.exit(1);
};

const require = createRequire(import.meta.url);
let src;
try {
    src = require.resolve("@333eco/corpus/corpus.json");
} catch {
    die("@333eco/corpus is not installed. Run: npm install");
}

const pkg = JSON.parse(readFileSync(join(BASE, "node_modules", "@333eco", "corpus", "package.json"), "utf8"));
const pinned = JSON.parse(readFileSync(join(BASE, "package.json"), "utf8")).dependencies["@333eco/corpus"];

// An exact pin, deliberately. A range would reintroduce the drift the whole
// design exists to prevent — the worker would silently serve whatever the last
// `npm install` happened to resolve.
if (/[\^~*x]|-/.test(pinned)) {
    die(`@333eco/corpus is pinned as "${pinned}". It must be an EXACT version, not a range: a range makes "which corpus is deployed" unanswerable.`);
}
if (pkg.version !== pinned) {
    die(`installed @333eco/corpus is ${pkg.version} but package.json pins ${pinned}. Run: npm install`);
}

const body = readFileSync(src);
const sha = createHash("sha256").update(body).digest("hex");

if (process.argv.includes("--check")) {
    if (!existsSync(DEST)) die("public/corpus.json is missing. Run: npm run sync");
    const have = createHash("sha256").update(readFileSync(DEST)).digest("hex");
    if (have !== sha) {
        die(
            `public/corpus.json does not match the installed @333eco/corpus@${pkg.version}.\n` +
                "  The worker would serve a different corpus than the package it claims to mirror.\n" +
                "  fix: npm run sync"
        );
    }
    console.log(`sync: public/corpus.json matches @333eco/corpus@${pkg.version} (${sha.slice(0, 16)}…)`);
    process.exit(0);
}

mkdirSync(join(BASE, "public"), { recursive: true });
writeFileSync(DEST, body);
const c = JSON.parse(body.toString("utf8"));
console.log(`sync: public/corpus.json <- @333eco/corpus@${pkg.version} — ${c.document_count} documents, sha256 ${sha.slice(0, 16)}…`);
