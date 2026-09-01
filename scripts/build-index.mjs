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

// ⭐ WHERE THE HASHED BYTES ACTUALLY LIVE. The envelope carried a sha256 and an
// instruction to "compare to the source file" without ever saying WHICH file or
// WHERE — so verification was one lookup short of possible, and the reader had to
// already know the repository layout to close it. All three source repositories
// are public, so the envelope can just name the raw URL and the check becomes one
// command.
//
// ⚠️ AND IT MATTERS THAT THE HASH IS OF THE WHOLE FILE, NOT OF `text`. `text` is
// the body — front matter stripped, trimmed — so hashing what you were served
// does NOT reproduce provenance.sha256, and an agent that tried would conclude the
// corpus was lying. The envelope now says so in as many words and points at the
// bytes that do hash correctly.
const GITHUB = {
    "TH/publications": "thonly/publications",
    "H3/publications": "HeartBank/publications",
    "missaquarius.org": "HeartBank/missaquarius.org"
};

const sourceUrl = (repo, path) => {
    const slug = GITHUB[repo];
    return slug ? `https://raw.githubusercontent.com/${slug}/main/${path}` : null;
};

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


/* ------------------------------------------------------------- the letters ---
   The Letters to Miss Aquarius are HTML rather than markdown, and they are the
   one genre where a document is only PARTLY in its author's voice: the banner on
   each says so — "scaffold awaiting founder revision", with the author's own
   articulations set as <blockquote class="v"> and the connective prose drafted
   for the letter form.

   ⭐ SO THEY ARE SERVED WHOLE, WITH THE VOICE MARKED INLINE. Serving only the
   author's passages was considered and rejected: it protects the voice by
   destroying the document, and a letter cut to its quotations is no longer a
   letter. Serving the whole thing behind a metadata disclaimer was rejected for
   the opposite reason — a field is something a consuming agent must LOOK at to
   heed, and an agent ingests text, forms a belief and cites.

   ⚠️ THE MARKER IS IN THE TEXT, AND THAT IS THE ENTIRE POINT. It does not make
   misattribution impossible; it inverts the default. With a metadata disclaimer
   an agent must look in order to know. With an inline marker it must STRIP in
   order not to. There is no unmarked copy of the scaffold anywhere in the
   response, so quoting a scaffold sentence carries its label unless someone
   removes it on purpose. Opt-out rather than opt-in — the honest limit is that
   it is not a guarantee.

   `segments` carries the same split structurally, for consumers that would
   rather not parse prose. */

const VOICE_MARK = {
    author: "[VERBATIM — Thon Ly]",
    scaffold: "[SCAFFOLD — drafted for the letter form, not in the author's voice; awaits his revision]"
};

const stripTags = (h) =>
    h
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&mdash;/g, "—")
        .replace(/&hellip;/g, "…")
        // Collapse the SOURCE file's line wrapping. HTML wraps for the editor's
        // benefit and those newlines carry no meaning; leaving them turns every
        // quoted paragraph into ragged text with stray leading spaces. Real
        // breaks came from <br> above and are preserved as \n\n.
        .replace(/\r/g, "")
        .split(/\n{2,}/)
        .map((para) => para.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();

const parseLetter = (html) => {
    let body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
    body = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");

    const title = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || null;
    const dateline = stripTags(body.match(/class="dateline"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "") || null;
    const banner = stripTags(body.match(/class="scaffold-banner"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "") || null;

    const segments = [];
    const re = /<(blockquote|p|h2|h3)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        const [, tag, attrs, inner] = m;
        const cls = attrs.match(/class="([^"]*)"/)?.[1] ?? "";
        // The banner becomes the envelope's editorial block rather than body text:
        // a notice about the document is not part of the document.
        if (cls.includes("scaffold-banner")) continue;
        // The <h1> and the paragraph that carries it are the title block; the
        // title is already a field, and repeating it as body prose would label
        // the document's own name as scaffold.
        if (cls.includes("part") || cls.includes("inst") || cls.includes("glyph")) continue;
        const text = stripTags(inner);
        if (!text) continue;
        if (/^h[23]$/i.test(tag)) segments.push({ voice: "structural", kind: "heading", text });
        else if (cls.split(/\s+/).includes("v")) segments.push({ voice: "author", kind: "quotation", text });
        // ⚠️ STRUCTURAL IS NOT SCAFFOLD. A salutation, a dateline or a signature
        // is the letter's furniture, not drafted connective prose, and marking
        // "My dear Miss Aquarius," as not-his-voice is both wrong and insulting to
        // the document. Only the drafted prose gets the scaffold label.
        else if (["dateline", "signature", "place", "name", "salutation"].some((k) => cls.includes(k))) {
            segments.push({ voice: "structural", kind: cls.trim(), text });
        } else segments.push({ voice: "scaffold", kind: "prose", text });
    }

    const rendered = segments
        .map((s) => {
            if (s.voice === "structural") return s.kind === "heading" ? `## ${s.text}` : s.text;
            if (s.voice === "author") return `${VOICE_MARK.author}\n> ${s.text.replace(/\n/g, "\n> ")}`;
            return `${VOICE_MARK.scaffold}\n${s.text}`;
        })
        .join("\n\n");

    return { title, dateline, banner, segments, text: rendered };
};

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
            // ── the letters: HTML, partly in the author's voice ──
            if (genre === "letters" && file.endsWith(".html") && file !== "index.html") {
                const rel = `${genre}/${file}`;
                const raw = readFileSync(join(root, genre, file));
                const html = raw.toString("utf8");
                // Same gate as everything else: no declaration, not served.
                if (!/CC0/.test(html)) {
                    excluded.push({ repo, rel, reason: "no CC0 declaration" });
                    continue;
                }
                const L = parseLetter(html);
                const authorBlocks = L.segments.filter((x) => x.voice === "author").length;
                const scaffoldBlocks = L.segments.filter((x) => x.voice === "scaffold").length;
                documents.push({
                    slug: file.replace(/\.html$/, "") + "-letter-to-miss-aquarius",
                    repo,
                    genre,
                    path: rel,
                    // "Letter to Miss Aquarius" is the <h1> on all five, so the
                    // ordinal comes from the dateline or the filename. Five
                    // documents sharing one title are five documents nobody can
                    // tell apart in a list.
                    title: L.dateline
                        ? `${L.dateline.split("·")[0].trim()} to Miss Aquarius`
                        : `${file.replace(/\.html$/, "")} letter to Miss Aquarius`,
                    subtitle: L.dateline,
                    authors: "Thon Ly",
                    category: "letters",
                    date: (L.dateline?.match(/(\d{1,2}\s+\w+\s+\d{4})/) ?? [])[1] ?? null,
                    status: "scaffold-awaiting-author-revision",
                    licence: ALLOWED["CC0-1.0"],
                    metadata_convention: "html",
                    text: L.text,
                    segments: L.segments,
                    // ⚠️ NOT A DISCLAIMER IN A FIELD — the markers are in `text`
                    // too. This block tells a structured consumer what the inline
                    // convention MEANS; it is not the only place the warning lives,
                    // which is exactly why it is safe to have.
                    editorial: {
                        status: "scaffold-awaiting-author-revision",
                        notice: L.banner,
                        annotation:
                            "Voice is marked INLINE in `text`. Blocks prefixed \"[VERBATIM — Thon Ly]\" are the " +
                            "author's own words; blocks prefixed \"[SCAFFOLD …]\" were drafted for the letter form " +
                            "and are NOT his voice. Quote only VERBATIM blocks as the author's words. `segments` " +
                            "carries the same split structurally.",
                        verbatim_blocks: authorBlocks,
                        scaffold_blocks: scaffoldBlocks
                    },
                    provenance: {
                        sha256: sha256(raw),
                        doi: null,
                        concept_doi: null,
                        zenodo_url: null,
                        deposited_sha256: null,
                        deposited_matches_current: null,
                        opentimestamps: existsSync(join(root, genre, file + ".ots")),
                        source_url: sourceUrl(repo, rel),
                        sha256_covers:
                            "the complete source HTML at source_url — NOT the `text` field, which is a derived " +
                            "plain-text rendering with voice annotation added",
                        derived: true,
                        canonical_url: `https://missaquarius.org/letters/${file}`
                    }
                });
                continue;
            }
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
                    source_url: sourceUrl(repo, rel),
                    // What provenance.sha256 covers, said plainly: the whole file
                    // as committed, not the `text` field this response carries.
                    sha256_covers: "the complete source file at source_url, including its metadata block — NOT the `text` field in this response",
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
