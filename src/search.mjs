// How `search_corpus` decides a document matches.
//
// ⭐⭐ SHARED, AND IT HAS TO BE. The two surfaces keep their own `callTool` on
// purpose — twenty lines each, diffable by eye. Matching is not that: it is
// ranking, tokenising and window-finding, and if the stdio server and the worker
// ever disagreed about which documents answer a query, the corpus would have two
// opinions about itself. That is the same failure `sync.mjs` exists to prevent,
// arriving through the search path instead of the data path.
//
// ⚠️ WHY THIS REPLACED A BARE `indexOf`, and the evidence was a real caller.
// The first external client to reach the hosted endpoint searched
// `"gratitude alignment human wellbeing kindness"` and got ZERO results — while
// `gratitude` alone returns 50, `alignment` 50, `kindness` 50, `wellbeing` 16.
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

const TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

// Dropped only when something survives the dropping. These are words present in
// essentially every document, so they never narrow the result set — but they do
// wreck the tightest-window calculation, because an "and" is always close by.
const STOP = new Set(["a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with"]);

export const terms = (query) => {
    const all = String(query ?? "").toLowerCase().match(TOKEN) ?? [];
    const kept = all.filter((t) => !STOP.has(t));
    return kept.length ? kept : all;
};

const clip = (body, centre, span) => {
    const from = Math.max(0, Math.min(centre - Math.floor(span / 2), body.length - span));
    const start = Math.max(0, from);
    return (start > 0 ? "…" : "") + body.slice(start, start + span).trim() + (start + span < body.length ? "…" : "");
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
    const hay = body.toLowerCase();
    const phrase = String(query ?? "").toLowerCase().trim();

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
    const hays = documents.map((d) => d.text.toLowerCase());
    return ts.filter((t) => !hays.some((h) => h.includes(t)));
};
