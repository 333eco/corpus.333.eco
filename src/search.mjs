// How `search_corpus` decides a document matches.
//
// ⭐⭐ SHARED, AND IT HAS TO BE — matching and, since 2.4.1, the whole search_corpus
// tool (see searchCorpus below). Matching is ranking, tokenising and window-finding, and
// if the stdio server and the worker
// ever disagreed about which documents answer a query, the corpus would have two
// opinions about itself. That is the same failure `sync.mjs` exists to prevent,
// arriving through the search path instead of the data path.
//
// ⚠️ WHY THIS REPLACED A BARE `indexOf`, and the evidence was a real caller.
// The first external client to reach the hosted endpoint searched
// `"gratitude alignment human wellbeing kindness"` and got ZERO results — while
// while each of those terms alone matched many documents.
// ⚠️ The per-term counts that used to sit on this line disagreed with the
// README's copy of the same anecdote (50 here, 109 there, 112 in the live
// corpus). A number in a comment about a corpus that grows is a number that
// will be wrong; the point of the story does not need it.
// The corpus was not missing the material; the matcher required that exact
// five-word string to appear verbatim, which of course it never does. A literal
// substring search silently punishes anyone who types a sentence, and it makes
// the zero-result signal MEAN THE WRONG THING: those queries were recording the
// matcher's limits while being read as gaps in the corpus.
//
// ⭐ PHRASE FIRST, THEN TERMS — the order is what keeps precision. This corpus is
// full of hyphenated marks (`B-Heart`, `Re-Tip`, `B-Sey`), and an exact phrase is
// always the strongest evidence a document is about the thing asked for. So an
// exact hit wins and is ranked above every term match. Only when the phrase is
// absent do we ask the weaker question: does this document contain ALL of these
// words, anywhere?
//
// ⚠️ The tokeniser KEEPS intra-word hyphens and apostrophes, so `B-Heart` is one
// token and not two. Splitting them would have made a search for `B-Heart` match
// any document containing "b" and "heart" separately — precision traded away for
// nothing, in the corpus where those marks matter most.

import { structuredWithText } from "./results.mjs";

const TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

// ⭐⭐ DIACRITICS ARE OPTIONAL IN A QUERY (2.4.1). A model types `metta`; the corpus writes
// `mettā`. Without a fold that search found 6 documents against 20, and `Tonle Sap` found none
// — a reader typing plain ASCII, which is most of them, silently missed most of the Pāli
// material. ⛔ FOLD TO MATCH, SERVE VERBATIM: the spelling is a tradition marker (Pāli for a
// Theravāda citation, Sanskrit for a Hindu one), so the fold touches only what is COMPARED —
// every excerpt is cut from the original text.
// ⚠️ LENGTH-PRESERVING, character by character, so a position in the folded text is the same
// position in the original and the excerpt window lands where the match is. Only Latin
// combining diacritics (U+0300–U+036F) are removed, and only where the base letter survives
// as one character: Khmer and Burmese vowel signs are marks too, and stripping them would
// make Khmer text match what it does not say.
const LATIN_MARKS = /[\u0300-\u036f]/g;
const foldChar = (c) => {
    const f = c.normalize("NFD").replace(LATIN_MARKS, "");
    return f.length === c.length ? f : c;
};
export const fold = (s) => String(s ?? "").replace(/[^\x00-\x7f]/gu, foldChar);

// The folded, lowercased body, computed once per document text rather than on every search.
// Keyed by the string itself: the corpus holds one string per document for the life of the
// process, so the cache is bounded by the corpus.
const HAY = new Map();
export const hayOf = (body) => {
    let h = HAY.get(body);
    if (h === undefined) {
        h = fold(body.toLowerCase());
        HAY.set(body, h);
    }
    return h;
};
const foldQuery = (query) => fold(String(query ?? "").normalize("NFC").toLowerCase());

// Dropped only when something survives the dropping. These are words present in
// essentially every document, so they never narrow the result set — but they do
// wreck the tightest-window calculation, because an "and" is always close by.
const STOP = new Set(["a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with"]);

export const terms = (query) => {
    const all = foldQuery(query).match(TOKEN) ?? [];
    const kept = all.filter((t) => !STOP.has(t));
    return kept.length ? kept : all;
};

// ⚠️ THE EDGES SNAP TO WHITESPACE, because a fixed-width slice cuts words in
// half — `…ratitude is immen…` — and a half-word at an excerpt boundary is not a
// cosmetic problem here. These excerpts are read by agents deciding whether a
// document is worth fetching, and a truncated token is a token that can be
// matched, quoted or reasoned about as if it were a word.
//
// ⚠️ THE SNAP IS BUDGETED, AND THE BUDGET IS THE WHOLE SAFETY OF IT. A corpus
// document can contain a 200-character unbroken run — a base64 blob, a sha256, a
// long URL — and an unbounded search for whitespace would eat the entire excerpt
// looking for a space that is not there. Past LOOK characters we accept the hard
// cut: a slightly ugly excerpt beats an empty one.
const LOOK = 40;

const clip = (body, centre, span) => {
    if (body.length <= span) return body.trim();

    let start = Math.max(0, Math.min(Math.round(centre - span / 2), body.length - span));
    let end = start + span;

    // ⭐ EACH EDGE TRIES BOTH DIRECTIONS, and the second direction is what fixes
    // the long-token case. Snapping INWARD is preferred (it never grows the
    // excerpt), but this corpus is full of runs that exceed LOOK with no space
    // in them at all — `project_future_kindness_operating_noun`, bare URLs,
    // markdown link targets, sha256 hex. Inward alone gave up on exactly those
    // and left the half-word it was meant to prevent. Snapping OUTWARD instead
    // costs at most LOOK extra characters and always lands on a real boundary.
    if (start > 0) {
        const ahead = body.slice(start, start + LOOK).search(/\s/);
        if (ahead !== -1) {
            start += ahead + 1;
        } else {
            const back = /\s\S*$/.exec(body.slice(Math.max(0, start - LOOK), start));
            if (back) start = Math.max(0, start - LOOK) + back.index + 1;
        }
    }
    if (end < body.length) {
        const from = Math.max(start + 1, end - LOOK);
        const back = /\s\S*$/.exec(body.slice(from, end));
        if (back) {
            end = from + back.index;
        } else {
            const ahead = body.slice(end, end + LOOK).search(/\s/);
            end = ahead !== -1 ? end + ahead : Math.min(body.length, end + LOOK);
        }
    }
    if (end <= start) end = Math.min(body.length, start + span); // pathological input

    return (start > 0 ? "…" : "") + body.slice(start, end).trim() + (end < body.length ? "…" : "");
};

// Positions of a term, capped: a common word can appear thousands of times and
// the window sweep only needs enough of them to find a tight one.
const positions = (hay, term, cap = 200) => {
    const out = [];
    let i = hay.indexOf(term);
    while (i !== -1 && out.length < cap) {
        out.push(i);
        i = hay.indexOf(term, i + term.length);
    }
    return out;
};

// Smallest span containing at least one occurrence of every term. Classic sweep
// over the merged, sorted occurrence list — linear in the number of positions.
const tightestWindow = (lists) => {
    const merged = [];
    lists.forEach((ps, t) => ps.forEach((p) => merged.push([p, t])));
    merged.sort((a, b) => a[0] - b[0]);
    const need = lists.length;
    const seen = new Map();
    let best = null;
    let left = 0;
    for (let right = 0; right < merged.length; right++) {
        seen.set(merged[right][1], (seen.get(merged[right][1]) ?? 0) + 1);
        while (seen.size === need) {
            const width = merged[right][0] - merged[left][0];
            if (!best || width < best.width) best = { width, from: merged[left][0], to: merged[right][0] };
            const t = merged[left][1];
            const n = seen.get(t) - 1;
            if (n === 0) seen.delete(t);
            else seen.set(t, n);
            left++;
        }
    }
    return best;
};

// null when the document does not match; otherwise the excerpt, how it matched,
// and a score for ranking. ⭐ `mode` is returned rather than hidden because a
// term match's excerpt may NOT contain the literal query, and a caller reading
// an excerpt deserves to know which question it answered.
export const match = (body, query, span = 320) => {
    const hay = hayOf(body);
    const phrase = foldQuery(query).trim();

    if (phrase) {
        const i = hay.indexOf(phrase);
        // An exact hit always wins: score is above anything a window can score.
        if (i !== -1) return { mode: "phrase", excerpt: clip(body, i + phrase.length / 2, span), score: 1e9 };
    }

    const ts = [...new Set(terms(query))];
    // A single term has already been tried as a phrase; there is no weaker
    // question left to ask, so a miss is a miss.
    if (ts.length < 2) return null;

    const lists = ts.map((t) => positions(hay, t));
    if (lists.some((l) => l.length === 0)) return null; // AND, not OR

    const win = tightestWindow(lists);
    if (!win) return null;
    // Tighter is better; every term match ranks below every phrase match.
    return { mode: "terms", excerpt: clip(body, Math.floor((win.from + win.to) / 2), span), score: 1e6 / (1 + win.width) };
};

// Rank and cut. Phrase matches first, then tighter term windows, corpus order
// breaking ties (Array.prototype.sort is stable).
export const rank = (hits, limit) =>
    hits.slice().sort((a, b) => b.m.score - a.m.score).slice(0, Math.max(0, limit));

// ⭐⭐ WHICH TERMS APPEAR IN NO DOCUMENT AT ALL. Under AND-matching a zero result
// means at least one term is missing, and saying WHICH turns a dead end into a
// finding: `unicorn` absent is a fact about the corpus, while `wellbeing` absent
// would be a fact about the query. Computed only when a search returns nothing,
// so the cost never lands on a successful call — and it is exactly the sentence
// a caller would otherwise have to write to us by hand.
export const absentTerms = (documents, query) => {
    const ts = [...new Set(terms(query))];
    if (ts.length === 0) return [];
    const hays = documents.map((d) => hayOf(d.text));
    return ts.filter((t) => !hays.some((h) => h.includes(t)));
};

/* ---------------------------------------------------------- search_corpus ---
   ⭐ THE WHOLE TOOL, SHARED (2.4.1). It lived twice, once in each surface's callTool, and
   its guidance line was about to be written twice too — the shape in which the envelope
   drifted. One function, imported by both. */

// A search returns EXCERPTS, and a model that reads only excerpts answers from them. So the
// text a model reads says so at the moment it decides what to do next — in the result, where
// every client delivers it, rather than only in server instructions a client may drop.
const readingLine = (results, matches) => {
    const slugs = results.map((r) => r.slug);
    return (
        `[Showing ${results.length} of ${matches} matching document${matches === 1 ? "" : "s"}, as excerpts. ` +
        `To answer from the full texts, call read_documents with slugs ${JSON.stringify(slugs)}` +
        (matches > results.length ? `; raise limit to see more of the ${matches} matches` : "") +
        ".]"
    );
};

export const searchCorpus = ({ documents, envelope }, args) => {
    const q = String(args?.query ?? "");
    if (!q) throw new Error("query is required");
    const pool = documents.filter((d) => !args?.genre || d.genre === args.genre);
    const hits = pool.map((d) => ({ d, m: match(d.text, q) })).filter((h) => h.m !== null);
    const results = rank(hits, Number(args?.limit ?? 10)).map((h) => ({
        ...envelope(h.d),
        genre: h.d.genre,
        excerpt: h.m.excerpt,
        // ⭐ HOW it matched, not just that it did: a "terms" excerpt need not
        // contain the literal query, and a caller reading it should know
        // which question the excerpt is answering.
        match: h.m.mode
    }));
    // ⚠️ `matches` is the TOTAL found, not the number returned — it used to be
    // capped at `limit`, which made "10 matches" and "at least 10 matches"
    // indistinguishable. `returned` carries the capped count.
    const absent = hits.length ? [] : absentTerms(pool, q);
    const readable = results.length
        ? results.map((h) => `${h.slug} — ${h.title}${h.match === "terms" ? "  [all terms, not the phrase]" : ""}\n  ${h.excerpt}`).join("\n\n") +
          "\n\n" + readingLine(results, hits.length)
        : absent.length
          ? `no document matches "${q}". No document contains: ${absent.join(", ")}.`
          : `no document matches "${q}" — every term appears somewhere, but no single document holds them all. Try fewer terms.`;
    return structuredWithText(readable, {
        query: q,
        matches: hits.length,
        returned: results.length,
        // ⛔ 2.4.2: the reading line was in `content` only, and a Claude client shows its model only
        // structuredContent — so the 2.4.1 nudge reached no Claude reader. It rides here too.
        ...(results.length ? { reading: readingLine(results, hits.length) } : {}),
        ...(absent.length ? { absent_terms: absent } : {}),
        results: results
    });
};
