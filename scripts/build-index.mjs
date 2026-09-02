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

/* ------------------------------------------------------- the research program ---
   ⭐ WHY THIS IS PARSED HERE AND NOT IN THE SERVER. The prediction register is a
   markdown document, served whole like any other; this block additionally lifts
   its tables into records so an agent can ask "what would falsify P-L2, and has
   it run?" without parsing markdown. That extraction belongs in the ARTIFACT,
   beside the licence gate, for the same reason the gate does — a server that
   parsed documents could be refactored into one that reads files, and then
   nothing structural is left. dist/corpus.json stays the only thing it may open.

   ⛔ EVERY FIELD IS A VERBATIM TABLE CELL. Nothing is condensed, re-worded or
   scored. `state` is the one derived field and it is a FACET for filtering, never
   a reading: the verbatim `status` travels beside it always, because a status
   like "RUN 2026-08-07 → PARTIAL NULL. Read the full result before any uniqueness
   claim" carries a warning no enum can.

   ⚠️ AND THE REGISTER IS NOT THE AUTHORITY — IT SAYS SO ITSELF: "verify the
   stating paper against its stored proof rather than trusting this register —
   this file is a convenience index, and the proofs are the evidence." So every
   record resolves to its STATING PAPER, and the server returns that paper's
   envelope rather than the register's. */

const REGISTER = "prediction-register";
const PROGRAM = "which-way-value-moves";

const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
const isRule = (c) => c.every((x) => /^-*:?-*$/.test(x) || x === "");
const unbold = (s) => s.replace(/^\*\*(.*)\*\*$/, "$1").trim();

// A facet, not a verdict. Anything unrecognised becomes "other" rather than being
// forced into a bucket — a wrong label is worse than an honest absence.
const facet = (status) => {
    const s = status.toLowerCase();
    if (s.includes("contradicted")) return "contradicted";
    if (s.includes("retired")) return "retired";
    if (s.includes("running")) return "running";
    if (/\brun\b/.test(s) && !s.startsWith("unrun")) return "run";
    if (s.startsWith("unrun")) return "unrun";
    return "other";
};

// Headings are matched with an optional ordinal because the two documents number
// differently: the register has "## Verification", the paper "## 8. The stopping
// rule". Hard-coding either shape breaks silently on the other.
// ⚠️ THE TERMINATOR MUST NOT BE `$`. Under /m it matches the end of EVERY line,
// so a lazy body stops at the first paragraph — which is exactly what happened:
// "The hard core" came back as its opening blockquote and nothing else, and the
// truncation is invisible because what you get is a real, correct-looking
// sentence. End-of-input is `$(?![\s\S])`; a following heading of any depth or a
// horizontal rule ends the section otherwise.
const verbatimSection = (text, heading) => {
    const re = new RegExp(`^##\\s+(?:\\d+\\.\\s+)?${heading}\\s*\\n+([\\s\\S]*?)(?=\\n#{2,}\\s|\\n---\\s*\\n|$(?![\\s\\S]))`, "m");
    return (re.exec(text) ?? [])[1]?.trim() ?? null;
};

const parseProgram = (registerText, programText, bySlug) => {
    const predictions = [], chapters = [], outside = [], withheld = [], counts = {};
    let section = null, header = null, carried = null;

    for (const line of registerText.split("\n")) {
        const h = /^##\s+(.+?)\s*$/.exec(line);
        if (h) {
            section = h[1];
            header = null;
            // ⚠️ A carried paper NEVER crosses a section boundary. The convention
            // is "same table, row above"; letting it leak between chapters would
            // attribute a prediction to a paper that never mentions it.
            carried = null;
            continue;
        }
        if (!section) continue;

        const gloss = /^\*(.+)\*$/.exec(line.trim());
        if (gloss && /^Chapter|^Core-level/.test(section) && !chapters.some((c) => c.name === section)) {
            chapters.push({ name: section, gloss: gloss[1], predictions: 0 });
        }
        if (!line.trim().startsWith("|")) continue;

        const c = cells(line);
        if (isRule(c)) continue;
        if (header === null) { header = c.map((x) => x.toLowerCase()); continue; }

        if (section === "Summary") {
            if (c.length === 2 && c[1]) {
                counts[unbold(c[0]).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] = unbold(c[1]);
            }
            continue;
        }
        if (section === "Withheld") { withheld.push({ id: unbold(c[0]), reason: c[1] }); continue; }
        if (section.startsWith("Instrumented")) {
            outside.push({ ids: unbold(c[0]), paper: c[1].replace(/`/g, ""), subject: c[2] });
            continue;
        }
        if (!/^Core-level$|^Chapter/.test(section)) continue;

        const iFals = header.findIndex((x) => x.startsWith("falsifier"));
        const iStat = header.indexOf("status");
        const iProv = header.indexOf("provenance");
        // ⚠️ AN IDENTIFIER IS A `P-…` TOKEN AND NOTHING ELSE. Two rows carry
        // something else in the ID column — "—" for the contradicted
        // kids-as-triggers result, and "*(unnumbered)*" for a desk census the
        // register explicitly calls "not a registered prediction; recorded
        // because it was run and returned null". Both are real rows and are
        // kept; neither is an identifier, and counting them as such is what
        // made this parser disagree with the register's own total.
        const raw0 = unbold(c[0]).replace(/^\*(.*)\*$/, "$1").trim();
        const id = /^P-[A-Za-z0-9]+$/.test(raw0) ? raw0 : null;
        const provenance = c[iProv] ?? "";
        const named = /`([a-z0-9-]+)`/.exec(provenance);
        if (named) carried = named[1];

        // A bare "Published" inherits the paper from the row above — a table
        // convention, checked below rather than trusted: P-S1 names
        // `the-sport-that-says-your-name` and P-S2…P-S8 inherit it, and all seven
        // identifiers do occur in that paper.
        const published = /^Published/.test(provenance);
        const firstHere = /^First public here/.test(provenance);
        const inferred = published && !named;

        const record = {
            id,
            // The register counts IDENTIFIERS. A row without one is reported
            // rather than dropped — it is a result, just not a registration.
            registered: id !== null,
            level: section === "Core-level" ? "core" : "chapter",
            chapter: section,
            prediction: c[1],
            falsifier: iFals >= 0 && c[iFals] && c[iFals] !== "—" ? c[iFals] : null,
            status: c[iStat],
            state: facet(c[iStat]),
            stating_paper: {
                // "Internal" is neither published nor first-public-here — it
                // names no paper, and inventing one would be the only dishonest
                // field in this block.
                slug: published ? (named ? named[1] : carried) : firstHere ? REGISTER : null,
                section: (/`[a-z0-9-]+`\s*(§[\d.]+)/.exec(provenance) ?? [])[1] ?? null,
                // named — the row names the paper. inferred — carried from above.
                // register — first published in the register itself.
                attribution: published ? (inferred ? "inferred" : "named") : firstHere ? "register" : "none",
                verified_in_paper: null
            },
            provenance_text: provenance
        };
        const ch = chapters.find((x) => x.name === section);
        if (ch) ch.predictions++;
        predictions.push(record);
    }

    // ⭐ THE BUILDER CHECKS ITS OWN INFERENCE against the papers it is indexing.
    // A convention read correctly sixty-six times can still be wrong the
    // sixty-seventh, and the failure is silent: a prediction confidently
    // attributed to a paper that has never heard of it.
    const unverified = [];
    for (const p of predictions) {
        const sp = p.stating_paper;
        if (!p.id || !sp.slug || sp.slug === REGISTER) continue;
        const paper = bySlug.get(sp.slug);
        if (!paper) { sp.verified_in_paper = false; unverified.push({ id: p.id, paper: sp.slug, why: "paper is not in the corpus" }); continue; }
        sp.verified_in_paper = paper.text.includes(p.id);
        if (!sp.verified_in_paper) unverified.push({ id: p.id, paper: sp.slug, why: `identifier does not occur in that paper (attribution: ${sp.attribution})` });
    }

    // Chapter IV states its emptiness in prose instead of a table, and that is
    // load-bearing — "That is reported, not hidden." A consumer shown three
    // chapters would read an omission where the register made a statement.
    const empty = /^##\s+(Chapter IV[^\n]*)\n\*(.+?)\*\n+\*\*(This chapter has no predictions\.)\*\*\n+([\s\S]*?)(?=\n---)/m.exec(registerText);
    if (empty) {
        // ⚠️ ATTACH, do not push. The chapter is already in the list — its
        // italic gloss put it there — so a `some(...)` guard silently dropped
        // the note, leaving an empty chapter that looked like an omission
        // rather than the statement the register is making.
        const note = (empty[3] + " " + empty[4]).replace(/\s*\n+\s*/g, " ").trim();
        const existing = chapters.find((c) => c.name === empty[1]);
        if (existing) existing.note = note;
        else chapters.push({ name: empty[1], gloss: empty[2], predictions: 0, note });
    }

    const hardCore = verbatimSection(programText, "The hard core");
    const fourChapters = verbatimSection(programText, "The four chapters");
    const honestLimits = verbatimSection(programText, "Honest limits");
    const stoppingRule = verbatimSection(programText, "The stopping rule");
    const revisionRule = verbatimSection(registerText, "Revision rule");
    const verification = verbatimSection(registerText, "Verification");

    // ⭐⭐ THE REGISTER CHECKS ITS OWN ARITHMETIC ON EVERY BUILD. Its revision log
    // records that the Summary's counts were wrong at first publication and says
    // the property to preserve is that they reconcile: "an arithmetic check that
    // reconciles — 50 + 20 = 70 — is the property to preserve on every future
    // revision; the previous split summed correctly to a total that was itself
    // one too high, which is how it survived." A register that miscounts itself
    // has failed at the one thing it exists to do, so the count is derived from
    // the tables here and compared with the stated one.
    const identifiers = new Set([
        ...predictions.filter((p) => p.id).map((p) => p.id),
        ...outside.flatMap((o) => o.ids.split(/,\s*/).map((s) => s.trim())),
        ...withheld.map((w) => w.id)
    ]);
    const stated = Number(String(counts.total_registered ?? "").replace(/\D/g, "")) || null;
    const reconciliation = {
        stated_total_registered: stated,
        counted_from_tables: identifiers.size,
        reconciles: stated === identifiers.size,
        counted_as: {
            core_and_chapters: predictions.filter((p) => p.id).length,
            instrumented_outside_core: outside.reduce((n, o) => n + o.ids.split(/,\s*/).length, 0),
            withheld: withheld.length,
            rows_without_an_identifier: predictions.filter((p) => !p.id).length
        }
    };

    // ⭐⭐ "NEVER SUMMARISE" MADE A PROPERTY OF THE BUILD RATHER THAN A PROMISE IN
    // A COMMENT. Every string this block emits must occur LITERALLY in the
    // document it came from; if one does not, something here has re-worded the
    // corpus and the build stops. This caught nothing on the day it was written —
    // it exists for the day a well-meaning refactor "tidies" a cell, which is
    // precisely when nobody would be looking.
    // ⚠️⚠️ `source.includes(value)` IS NOT THIS TEST, and believing it was is a
    // trap worth recording: it asks "does this text occur?", so trimming a cell's
    // first word still passes — the trimmed string remains a substring of the
    // untrimmed one. Proven by tampering with the parser on 2026-09-02: a version
    // that stripped a leading "The " from every prediction built CLEANLY under an
    // includes() guard. A cell must therefore be matched WITH ITS DELIMITERS, so
    // the claim is "this is the whole cell" rather than "this appears somewhere".
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const verbatimCell = (label, value, source) => {
        if (value === null || value === undefined) return value;
        if (!new RegExp(`\\|\\s*${escape(value)}\\s*\\|`).test(source)) {
            die(`the program block would emit non-verbatim text for ${label} — a field must be a COMPLETE table cell of its source document, not a fragment of one`);
        }
        return value;
    };
    // Prose sections carry no delimiters, so the boundary is checked instead: the
    // extract must begin right after its own heading and end at a heading, a rule
    // or end-of-file. That is the failure this catches — silent truncation, which
    // returns a real sentence and looks entirely correct.
    const verbatimSectionCheck = (label, value, source) => {
        if (value === null || value === undefined) {
            die(`the program block found no text for ${label} — the heading it extracts from has moved or been renamed`);
        }
        const at = source.indexOf(value);
        if (at < 0) die(`the program block would emit non-verbatim text for ${label}`);
        const after = source.slice(at + value.length);
        if (!/^\s*(?:#{2,}\s|---\s*\n|$)/.test(after)) {
            die(`the program block's ${label} does not end at a section boundary — it has been silently truncated mid-section`);
        }
        return value;
    };
    for (const [label, value] of [
        ["hard_core", hardCore], ["four_chapters", fourChapters],
        ["honest_limits", honestLimits], ["stopping_rule", stoppingRule]
    ]) verbatimSectionCheck(label, value, programText);
    for (const [label, value] of [["revision_rule", revisionRule], ["verification", verification]])
        verbatimSectionCheck(label, value, registerText);
    for (const pr of predictions) {
        const at = pr.id ?? "(unnumbered)";
        verbatimCell(`${at}.prediction`, pr.prediction, registerText);
        verbatimCell(`${at}.falsifier`, pr.falsifier, registerText);
        verbatimCell(`${at}.status`, pr.status, registerText);
    }

    return {
        question: "Which Way Value Moves",
        documents: [PROGRAM, REGISTER],
        hard_core: hardCore,
        four_chapters: fourChapters,
        honest_limits: honestLimits,
        stopping_rule: stoppingRule,
        revision_rule: revisionRule,
        verification: verification,
        counts,
        reconciliation,
        chapters,
        prediction_count: predictions.length,
        predictions,
        instrumented_outside_core: outside,
        withheld,
        unverified_attributions: unverified
    };
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
        // ⛔ INFRASTRUCTURE ONLY. `program` sat in this list until 2026-09-02 and
        // silently kept two CC0-1.0 tier-A documents — the research program and
        // its prediction register — out of the index, while every sibling surface
        // (zenodo-deposit.py, markdownFor, llms.txt, prerender corpusPath) had
        // been taught about them. A directory denylist is the mechanism the
        // comment at the top of this file says the design does not use: the
        // licence gate is a property of each file, so anything that is a genre
        // belongs here on its own merits. Add only names that are NOT genres.
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["timestamps", "scripts", "node_modules"].includes(e.name))
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
                // ⚠️ BOTH SPELLINGS. 99 documents write `authors:`; the seven
                // author-voice essays write `author:` — and those seven are
                // exactly the CC-BY set, the only documents where attribution is
                // legally required. Reading only the plural gave every one of them
                // `authors: null`, and the envelope's `attribution_required &&
                // d.authors` guard then dropped `attribute_to` silently. ⭐ The
                // guard hid the bug: the field vanished precisely where it was
                // owed, and nothing anywhere reported a problem.
                authors: fm.authors || fm.author || null,
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

// ⛔⛔ A CC-BY DOCUMENT WITHOUT AN AUTHOR CANNOT BE SERVED. Its licence obliges
// every consumer to attribute, and an index that cannot say to whom hands out an
// obligation nobody can discharge — worse than an undeclared licence, because it
// looks complete. Made a build failure rather than a warning, on the same
// reasoning as the licence gate itself: a property, not a rule someone remembers.
const unattributable = documents.filter((d) => d.licence.attribution_required && !d.authors);
if (unattributable.length) {
    die(
        "these documents require attribution and name no author:\n" +
            unattributable.map((d) => `    ${d.repo}/${d.path}`).join("\n") +
            "\n  Add `author:` or `authors:` to the metadata block, or change the licence."
    );
}

// ── the research program, lifted from the two documents that state it ──
// Absent is not an error: the program lives in TH/publications, so a build over
// H3 alone legitimately has none, and the server treats a missing block as
// "these tools are unavailable" rather than failing.
const docsBySlug = new Map(documents.map((d) => [d.slug, d]));
const program =
    docsBySlug.has(REGISTER) && docsBySlug.has(PROGRAM)
        ? parseProgram(docsBySlug.get(REGISTER).text, docsBySlug.get(PROGRAM).text, docsBySlug)
        : null;

// ⭐ THE PACKAGE VERSION IS BAKED INTO THE ARTIFACT, and that is the only place
// both surfaces can read it from. `serverInfo.version` was hand-written in two
// files ("1.0.0" and "1.0.1") while package.json said 1.2.5 — three numbers, none
// of which told a client which build it was talking to. The stdio server may not
// read the filesystem (see src/server.mjs) and the worker has no filesystem at
// all, so a shared constant would drift again. ⚠️ The worker therefore reports
// the version of the CORPUS PACKAGE IT SERVES rather than of its own code, which
// is the truthful answer for a surface whose whole design is an exact pin.
const pkgVersion = JSON.parse(readFileSync(join(BASE, "package.json"), "utf8")).version;

const index = {
    package_version: pkgVersion,
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
    documents: documents.sort((a, b) => a.slug.localeCompare(b.slug)),
    // ⚠️ NOT A SUMMARY OF THE REGISTER — a structured view of it, every field a
    // verbatim cell. The register is served whole as a document too, and that
    // document remains the citable artifact.
    ...(program ? { program } : {})
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
                "  \u26a0\ufe0f A version bump in package.json is also a rebuild: package_version is\n" +
                "     baked into the index so both surfaces can report the same number.\n" +
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
if (program) {
    const byState = program.predictions.reduce((a, p) => ((a[p.state] = (a[p.state] ?? 0) + 1), a), {});
    console.log(
        `  research program: ${program.prediction_count} predictions — ` +
            Object.entries(byState).map(([k, v]) => `${v} ${k}`).join(" · ")
    );
    // ⚠️ REPORTED, NEVER SWALLOWED. An attribution the builder could not confirm
    // is the one thing here a reader cannot check for themselves at a glance.
    const r = program.reconciliation;
    console.log(
        `  register arithmetic: ${r.counted_from_tables} identifiers counted from the tables vs ${r.stated_total_registered} stated — ` +
            (r.reconciles ? "reconciles" : "⚠️ DOES NOT RECONCILE")
    );
    for (const u of program.unverified_attributions) {
        console.log(`  ⚠️ ${u.id} → ${u.paper}: ${u.why}`);
    }
}
if (excluded.length) {
    console.log(`  ${excluded.length} excluded by the licence gate:`);
    for (const e of excluded) console.log(`    ${e.repo}/${e.rel} — ${e.reason}`);
}
