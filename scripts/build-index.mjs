#!/usr/bin/env node
//
// Builds dist/corpus.json from the corpus repositories.
//
//   node scripts/build-index.mjs --from ../../../TH/publications ../../../H3/publications
//   node scripts/build-index.mjs --check --from …     verify the committed index is current
//
// WHAT THIS PRODUCES, AND WHY IT IS NOT JUST A CONCATENATION. Every document in
// the index carries a PROVENANCE ENVELOPE: the sha256 computed here, the DOI and
// deposited hash from zenodo-dois.json, and whether an OpenTimestamps proof exists
// beside the source. The server hands that envelope back with every response, so
// a consuming agent can check the text it was given rather than trusting us.
//
// ⭐ THE INVERSION IS THE POINT. A retrieval server normally asks to be believed.
// This one ships the means to disbelieve it — and the means are only meaningful
// because the anchors already exist and are years old. Anyone can serve documents;
// the envelope is what cannot be manufactured on a schedule.
//
// ⛔⛔ THE LICENCE GATE IS A PROPERTY, NOT A POLICY. A file is included if and only
// if its own front matter declares a licence in ALLOWED. There is no glob, no
// directory allowlist, and no "everything under essays/". That matters because the
// corpora are NOT uniformly licensed and never were:
//
//   - TH/publications: 96 CC0-1.0 and 7 CC-BY author-voice essays
//   - TH/film:         rights-reserved, a separate repo BY LICENCE — never served
//   - 333.eco:         namespace.md is commercial policy, explicitly unpublished
//
// A glob over the corpus would have relicensed seven essays by publication. The
// repo's own README states the principle this enforces — the split is by licence —
// and the per-file field is the authority (TH/publications/LICENSE, scope note).
//
// ⚠️ AND IT REFUSES SILENTLY-UNLICENSED FILES RATHER THAN DEFAULTING. A document
// with no `license:` field is EXCLUDED and reported, never assumed CC0. The
// default-open failure mode is the one that cannot be undone after someone builds
// on it.
//
// House rules: node built-ins only, assertions that name the fix, non-zero exit.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = resolve(HERE, "..");
const OUT = join(BASE, "dist", "corpus.json");

const die = (msg) => {
    console.error(`build-index: ${msg}`);
    process.exit(1);
};

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
if (fromIdx === -1 || !args[fromIdx + 1]) {
    die(
        "needs --from <corpus repo> [<corpus repo> …]\n" +
            "  e.g. --from ../../../TH/publications ../../../H3/publications"
    );
}
const SOURCES = args.slice(fromIdx + 1).filter((a) => !a.startsWith("--"));

// The only licences this corpus publishes under. Both are open and both permit
// redistribution; CC-BY additionally requires attribution, which the envelope
// carries so a consuming agent can actually comply.
const ALLOWED = {
    "CC0-1.0": { id: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution_required: false },
    "CC-BY (author-voice essay)": { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/", attribution_required: true }
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const yamlFrontMatter = (text) => {
    if (!text.startsWith("---\n")) return null;
    const end = text.indexOf("\n---", 4);
    if (end === -1) return null;
    const fm = {};
    for (const line of text.slice(4, end).split("\n")) {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return { fm, bodyStart: end + 4, convention: "yaml" };
};

// ⚠️ THE TWO CORPORA DECLARE METADATA DIFFERENTLY, and the difference was
// invisible until something tried to read both. TH/publications uses YAML front
// matter; sixteen H3 documents use a leading markdown TABLE:
//
//     | Field   | Value                                    |
//     | License | [CC0 1.0 Universal …](https://…)         |
//
// They are not unlicensed — the gate's first run reported them as such, which was
// the gate being right about what it could read and wrong about what was there.
// Both forms are parsed, and each document records which convention it used so
// the divergence stays VISIBLE rather than silently normalised away. H3 should
// converge on front matter; until it does, this is the honest reading.
//
// ⛔ THE MATCH IS STRICT, DELIBERATELY. A licence gate that guesses is not a gate.
// The cell is stripped of markdown link syntax and must then BEGIN with a known
// licence name; anything else is excluded and reported, exactly as an unreadable
// YAML value would be.
const LICENCE_PREFIXES = [
    ["CC0 1.0 Universal", "CC0-1.0"],
    ["CC0-1.0", "CC0-1.0"],
    ["CC0", "CC0-1.0"]
];

const tableFrontMatter = (text) => {
    // Only the head of the document — a table further down is prose about a
    // table, not the document's own metadata block.
    const head = text.slice(0, 4000);
    const rows = [...head.matchAll(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/gm)];
    if (rows.length < 3) return null;
    const fm = {};
    for (const [, k, v] of rows) {
        const key = k.trim().toLowerCase();
        if (key === "field" || /^-+$/.test(key)) continue;
        // Strip [text](url) -> text, then trailing whitespace.
        fm[key] = v.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
    }
    if (!fm.license) return null;
    for (const [prefix, id] of LICENCE_PREFIXES) {
        if (fm.license.startsWith(prefix)) {
            fm.license = id;
            break;
        }
    }
    // Title from the leading H1, which is where these documents put it.
    const h1 = head.match(/^#\s+(.+)$/m);
    if (h1 && !fm.title) fm.title = h1[1].trim();
    return { fm, bodyStart: 0, convention: "table" };
};

const frontMatter = (text) => yamlFrontMatter(text) ?? tableFrontMatter(text);

/* --------------------------------------------------------------- the walk --- */

const documents = [];
const excluded = [];
const repos = new Set();

for (const src of SOURCES) {
    const root = resolve(BASE, src);
    if (!existsSync(root)) die(`${root} does not exist`);

    const repo = basename(root) === "publications" ? basename(dirname(root)) + "/publications" : basename(root);
    repos.add(repo);

    // Zenodo record, if the repo keeps one. Absent is fine — it means no DOIs,
    // not an error, and the envelope simply omits them.
    let zenodo = {};
    const zPath = join(root, "zenodo-dois.json");
    if (existsSync(zPath)) {
        try {
            zenodo = JSON.parse(readFileSync(zPath, "utf8"));
        } catch (e) {
            die(`${zPath} is not valid JSON: ${e.message}`);
        }
    }

    // Genre directories are discovered, never enumerated: a fixed list is correct
    // the day it is written and stops covering the repo the moment one is added.
    const genres = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["timestamps", "scripts", "program", "node_modules"].includes(e.name))
        .map((e) => e.name);

    for (const genre of genres.sort()) {
        for (const file of readdirSync(join(root, genre)).sort()) {
            if (!file.endsWith(".md") || file === "README.md") continue;
            const rel = `${genre}/${file}`;
            const raw = readFileSync(join(root, genre, file));
            const text = raw.toString("utf8");
            const parsed = frontMatter(text);

            if (!parsed) {
                excluded.push({ repo, rel, reason: "no readable metadata block (neither YAML front matter nor a leading table)" });
                continue;
            }
            const { fm, bodyStart, convention } = parsed;

            // ⛔ THE GATE. No declaration, or a declaration we do not publish
            // under, means the document is not served. Never defaulted.
            const licence = ALLOWED[fm.license];
            if (!licence) {
                excluded.push({ repo, rel, reason: fm.license ? `licence not served: ${fm.license}` : "no licence declared" });
                continue;
            }

            const slug = fm.slug || file.replace(/\.md$/, "");
            const z = zenodo[slug];

            documents.push({
                slug,
                repo,
                genre,
                path: rel,
                title: fm.title || slug,
                subtitle: fm.subtitle || null,
                authors: fm.authors || null,
                category: fm.category || null,
                metadata_convention: convention,
                date: fm.date || null,
                status: fm.status || null,
                licence: licence,
                text: text.slice(bodyStart).trim(),
                // ── the provenance envelope ──
                provenance: {
                    // Computed over the WHOLE FILE as it sits in the repo, front
                    // matter included — that is what the manifests and the OTS
                    // proof cover, so a different scope would produce a hash the
                    // reader cannot check against anything.
                    sha256: sha256(raw),
                    doi: z?.doi ?? null,
                    concept_doi: z?.concept_doi ?? null,
                    zenodo_url: z?.url ?? null,
                    // The hash Zenodo holds. ⚠️ It can legitimately differ from
                    // sha256 above when the file has been revised since deposit,
                    // and saying so is more useful than hiding it.
                    deposited_sha256: z?.sha256 ?? null,
                    deposited_matches_current: z?.sha256 ? z.sha256 === sha256(raw) : null,
                    opentimestamps: existsSync(join(root, genre, file + ".ots")),
                    canonical_url: fm.venue?.split(" ")[0] ?? null
                }
            });
        }
    }
}

if (documents.length === 0) die("no documents passed the licence gate — check --from paths");

const index = {
    // ⚠️ THE DERIVED REPO IDS, NEVER THE --from PATHS. This field held the raw
    // arguments until 2026-09-01, which meant the index could only be verified on
    // the machine that built it: CI checks the corpora out at .corpora/… and the
    // author builds from ../../../…, so --check failed on a byte that describes
    // the builder rather than the corpus. A guard whose output depends on where it
    // ran cannot verify anything anywhere else, which is the whole job.
    generated_from: [...repos].sort(),
    document_count: documents.length,
    licences: Object.fromEntries(
        Object.values(ALLOWED).map((l) => [l.id, documents.filter((d) => d.licence.id === l.id).length])
    ),
    documents: documents.sort((a, b) => a.slug.localeCompare(b.slug))
};

const body = JSON.stringify(index, null, 2) + "\n";

/* ---------------------------------------------------------------- output --- */

if (args.includes("--check")) {
    if (!existsSync(OUT)) die("dist/corpus.json is missing. Run without --check to build it.");
    if (readFileSync(OUT, "utf8") !== body) {
        die(
            "dist/corpus.json is not what the corpora currently produce.\n" +
                "  The index is STALE, which means the server would serve superseded text\n" +
                "  under an authoritative version number — worse than a stale website,\n" +
                "  because a citing agent cannot tell.\n" +
                "  fix: node scripts/build-index.mjs --from " + SOURCES.join(" ")
        );
    }
    console.log(`build-index: dist/corpus.json is current (${index.document_count} documents)`);
    process.exit(0);
}

mkdirSync(join(BASE, "dist"), { recursive: true });
writeFileSync(OUT, body);

const withDoi = documents.filter((d) => d.provenance.doi).length;
const withOts = documents.filter((d) => d.provenance.opentimestamps).length;
const drifted = documents.filter((d) => d.provenance.deposited_matches_current === false).length;

console.log(
    `build-index: ${index.document_count} documents — ` +
        Object.entries(index.licences).map(([k, v]) => `${v} ${k}`).join(" · ")
);
console.log(`  ${withDoi} with a DOI · ${withOts} with an OTS proof · ${drifted} revised since deposit`);
if (excluded.length) {
    console.log(`  ${excluded.length} excluded by the licence gate:`);
    for (const e of excluded) console.log(`    ${e.repo}/${e.rel} — ${e.reason}`);
}
