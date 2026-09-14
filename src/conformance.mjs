// check_passage — is this passage what the corpus serves? (roadmap A87 item 2; the mahāpadesa)
//
// ⭐ WHAT IT IS FOR. A machine reader that verifies a quotation against a content hash learns one bit:
// matched, or not. That bit is nearly useless in the case that actually occurs — a quotation that is
// ALMOST right: a word changed in transmission, a clause dropped, a curly quote straightened. The
// canon's answer to a disputed reading was to lay it beside the collection and see where it agrees and
// where it does not — judging the CLAIM, explicitly not the one who claims it. This is that test:
// where the passage is served, or the nearest served passage and exactly how the two differ.
//
// ⛔⛔ IT JUDGES THE PASSAGE, NEVER THE PERSON. No score of the asker, no inference about intent, no record
// of the passage text in telemetry. "Not served" says nothing about who wrote it or why.
//
// ⛔ FOLD TO MATCH, SERVE VERBATIM (search.mjs): case, Latin diacritics, punctuation and markdown are
// ignored when LOOKING; every excerpt returned is the corpus's own bytes, and the verdict says which of
// those differences, if any, separated the passage from the served text.
//
// ⚠️ A METADATA TOOL, so everything a reader needs is in structuredContent — a Claude client shows its
// model only that part (§the-text-never-arrived). `content` carries the same verdict, readable.

import { READ_ONLY } from "./base-tools.mjs";
import { fold, hayOf } from "./search.mjs";
import { structuredWithText } from "./results.mjs";

const MAX_CHARS = 2000;
const MIN_WORDS = 3;
const NEAR = 0.6; // share of the passage's words that must align before a nearest passage is offered

export const CONFORMANCE_TOOLS = [
    {
        name: "check_passage",
        title: "Check a passage against the corpus",
        annotations: { ...READ_ONLY, title: "Check a passage against the corpus" },
        description:
            "Is this passage in the corpus? Returns where it is served, or the nearest served passage and exactly how it " +
            "differs. Judges the passage, never who quotes it.",
        inputSchema: {
            type: "object",
            properties: {
                passage: { type: "string", description: `The text to check, up to ${MAX_CHARS} characters.` },
                slug: { type: "string", description: "Optional: check against one document only." }
            },
            required: ["passage"]
        }
    }
];

export const CONFORMANCE_TOOL_NAMES = CONFORMANCE_TOOLS.map((t) => t.name);

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const norm = (w) => fold(w.toLowerCase()).replace(/’/g, "'");
const words = (s) => [...s.matchAll(WORD)].map((m) => ({ w: norm(m[0]), i: m.index, e: m.index + m[0].length }));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]");
const squash = (s) => s.replace(/\s+/g, " ").trim();

// Where in a document a position falls: the nearest heading above it, and the line.
const locus = (text, at) => {
    const head = text.lastIndexOf("\n#", at);
    const line = head === -1 ? null : text.slice(head + 1, text.indexOf("\n", head + 1)).replace(/^#+\s*/, "");
    let n = 1;
    for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) n++;
    return { section: line || null, line: n };
};

// Word-level SEMI-GLOBAL alignment: the whole passage must align, the served text has free ends.
// ⚠️ Not a plain longest-common-subsequence — that matches the passage's first "the" to any earlier "the" in the
// window and reports every served word between them as "missing" (found by the known-case test, 2026-09-14).
// Scores: a match +2, a substituted word −1, a word present on only one side −1.
const align = (claimed, served) => {
    const n = claimed.length, m = served.length, W = m + 1;
    const H = new Int32Array((n + 1) * W), T = new Uint8Array((n + 1) * W); // T: 1 diagonal · 2 up (passage-only) · 3 left (served-only)
    for (let i = 1; i <= n; i++) { H[i * W] = -i; T[i * W] = 2; }
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
        const diag = H[(i - 1) * W + j - 1] + (claimed[i - 1].w === served[j - 1].w ? 2 : -1);
        const up = H[(i - 1) * W + j] - 1, left = H[i * W + j - 1] - 1;
        if (diag >= up && diag >= left) { H[i * W + j] = diag; T[i * W + j] = 1; }
        else if (up >= left) { H[i * W + j] = up; T[i * W + j] = 2; }
        else { H[i * W + j] = left; T[i * W + j] = 3; }
    }
    let jBest = 0;
    for (let j = 1; j <= m; j++) if (H[n * W + j] > H[n * W + jBest]) jBest = j;
    const ops = [];
    let i = n, j = jBest, matched = 0;
    while (i > 0) {
        const t = j > 0 ? T[i * W + j] : 2;
        if (t === 1) { const same = claimed[i - 1].w === served[j - 1].w; ops.push([same ? "=" : "x", i - 1, j - 1]); if (same) matched++; i--; j--; }
        else if (t === 2) { ops.push(["c", i - 1, -1]); i--; }
        else { ops.push(["s", -1, j - 1]); j--; }
    }
    ops.reverse();
    const js = ops.filter((o) => o[2] >= 0).map((o) => o[2]);
    return { matched, ops, first: js.length ? Math.min(...js) : -1, last: js.length ? Math.max(...js) : -1 };
};

export const checkPassage = ({ documents, bySlug, envelope }, args) => {
    const passage = String(args?.passage ?? "");
    if (!passage.trim()) throw new Error("passage is required");
    if (passage.length > MAX_CHARS) throw new Error(`passage may be at most ${MAX_CHARS} characters; check it in parts.`);
    const claimed = words(passage);
    if (claimed.length < MIN_WORDS) throw new Error(`a passage needs at least ${MIN_WORDS} words to be checked meaningfully.`);
    let pool = documents;
    if (args?.slug !== undefined) {
        const d = bySlug.get(String(args.slug));
        if (!d) throw new Error(`no document with slug "${args.slug}". Call list_documents to see what is available.`);
        pool = [d];
    }
    const note = "This judges the passage against the served text, never who wrote or quotes it. Verify the served text itself with its envelope's command.";
    const place = (d, start, end) => ({ slug: d.slug, title: d.title, ...locus(d.text, start), served_text: d.text.slice(start, end), ...envelope(d) });

    // 1 · Served? The same words in the same order, with anything that is not a letter or digit between them.
    const pattern = new RegExp(claimed.map((c) => escape(c.w)).join("[^\\p{L}\\p{N}]{1,24}"), "gu");
    const found = [];
    for (const d of pool) {
        const hay = hayOf(d.text); // folded and lowercased, LENGTH-PRESERVING — a position here is a position in d.text
        pattern.lastIndex = 0;
        for (let m = pattern.exec(hay); m && found.length < 5; m = pattern.exec(hay)) {
            const exact = squash(d.text.slice(m.index, m.index + m[0].length)) === squash(passage).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
            found.push({ match: exact ? "verbatim" : "same-words", ...place(d, m.index, m.index + m[0].length) });
        }
        if (found.length >= 5) break;
    }
    if (found.length) {
        const verbatim = found.some((f) => f.match === "verbatim");
        const verdict = verbatim ? "verbatim" : "same-words";
        const meaning = verbatim
            ? `Served verbatim in ${found.length === 1 ? "one place" : `${found.length} places`}.`
            : "Served with the same words in the same order; it differs only in punctuation, formatting, case or diacritics.";
        const readable = `${meaning}\n` + found.map((f) => `\n${f.slug}${f.section ? ` — ${f.section}` : ""} (line ${f.line})\n  ${f.served_text}`).join("\n") + `\n\n${note}`;
        return structuredWithText(readable, { verdict, meaning, passage_words: claimed.length, matches: found.length, found, note });
    }

    // 2 · Not served. Is there a passage close enough to show how it differs?
    const distinct = [...new Set(claimed.map((c) => c.w))];
    const anchors = [...distinct].sort((a, b) => b.length - a.length);
    const candidates = pool
        .map((d) => { const hay = hayOf(d.text); return { d, hay, cover: distinct.filter((w) => hay.includes(w)).length / distinct.length }; })
        .filter((c) => c.cover >= NEAR)
        .sort((a, b) => b.cover - a.cover)
        .slice(0, 5);
    let best = null;
    const span = Math.ceil(passage.length * 1.3) + 80;
    for (const { d, hay } of candidates) {
        const anchor = anchors.find((w) => hay.includes(w));
        let seen = 0;
        for (let at = hay.indexOf(anchor); at !== -1 && seen < 12; at = hay.indexOf(anchor, at + anchor.length), seen++) {
            const from = Math.max(0, at - span), to = Math.min(d.text.length, at + span);
            const served = words(d.text.slice(from, to)).map((w) => ({ ...w, i: w.i + from, e: w.e + from }));
            const a = align(claimed, served);
            if (a.first < 0) continue;
            const score = a.matched / claimed.length;
            if (!best || score > best.score) best = { d, served, a, score };
        }
    }
    if (!best || best.score < NEAR) {
        const meaning = "Not served. Nothing in the corpus comes close enough to show how it differs.";
        return structuredWithText(`${meaning}\n\n${note}`, { verdict: "not-found", meaning, passage_words: claimed.length, matches: 0, note });
    }

    // The differences, as runs: words only in the served text, only in the passage, or one in place of the other.
    const { d, served, a } = best;
    const differences = [];
    let run = null;
    const flush = () => { if (run && (run.claimed.length || run.served.length)) differences.push({
        kind: run.claimed.length && run.served.length ? "changed" : run.claimed.length ? "not in the served text" : "missing from the passage",
        served: run.served.join(" "), passage: run.claimed.join(" ") }); run = null; };
    for (const [op, i, j] of a.ops) {
        if (op === "=") { flush(); continue; }
        run ??= { claimed: [], served: [] };
        if (op === "c" || op === "x") run.claimed.push(passage.slice(claimed[i].i, claimed[i].e));
        if (op === "s" || op === "x") run.served.push(best.d.text.slice(served[j].i, served[j].e));
    }
    flush();
    const start = served[a.first].i, end = served[a.last].e;
    const nearest = { ...place(d, start, end), agreement: Number(best.score.toFixed(2)), differences: differences.slice(0, 20) };
    const meaning = `Not served as given. The nearest served passage shares ${Math.round(best.score * 100)}% of its words; the differences are listed.`;
    const readable =
        `${meaning}\n\n${d.slug}${nearest.section ? ` — ${nearest.section}` : ""} (line ${nearest.line})\n  ${nearest.served_text}\n\n` +
        nearest.differences.map((x) => `  · ${x.kind}: ${x.kind === "changed" ? `served "${x.served}", passage "${x.passage}"` : `"${x.served || x.passage}"`}`).join("\n") +
        `\n\n${note}`;
    return structuredWithText(readable, { verdict: "differs", meaning, passage_words: claimed.length, matches: 0, nearest, note });
};
