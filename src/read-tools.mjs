// Reading more than one document at a time, and knowing that nothing is missing —
// shared by both surfaces.
//
// ⭐ WHY THIS EXISTS (A140). A model connected to this server gave answers that were
// "quite accurate but incomplete": search returns excerpts, ten by default, and a
// model answers from the few documents it happens to open. The window was not the
// limit — a shelf of the corpus fits — the reading pattern was. So a caller can now
// ask for a whole slice and see its size first.
//
// ⭐ Imported by both surfaces, like the program tools and the envelope: the filter
// here must be the SAME filter list_documents applies, or
// "read what I just listed" returns a different set. One function makes that true
// by construction instead of by vigilance.

import { READ_ONLY } from "./base-tools.mjs";
import { documentText } from "./resources.mjs";

// ~22k tokens of English prose: under the 25,000-token default at which Claude Code
// moves a tool result out of the conversation and into a file. Other clients cap
// differently; the caller can ask for more.
export const DEFAULT_PAGE_BYTES = 90_000;
export const MAX_PAGE_BYTES = 400_000;

const byteLength = (s) => new TextEncoder().encode(s).length;

/** The list_documents filter. Every facet is optional; absent means "any". */
export const filterDocuments = (documents, args) =>
    documents.filter(
        (d) =>
            (!args?.genre || d.genre === args.genre) &&
            (!args?.licence || d.licence.id === args.licence) &&
            (!args?.voice || d.voice === args.voice) &&
            (!args?.category || d.category === args.category)
    );

export const READ_TOOLS = [
    {
        name: "read_documents",
        title: "Read a set of documents in full",
        annotations: { ...READ_ONLY, title: "Read a set of documents in full" },
        // ⚠️ KEPT SHORT ON PURPOSE: every client that loads tool definitions up front pays
        // for this text in every session, whether or not the corpus is used. The filter
        // facets are described once, on list_documents.
        description:
            "Whole documents, never summarised: those matching the list_documents filters, or the given slugs. " +
            "One content block each; the last block names the cursor for the next page.",
        inputSchema: {
            type: "object",
            properties: {
                genre: { type: "string" },
                category: { type: "string" },
                voice: { type: "string" },
                licence: { type: "string" },
                slugs: { type: "array", items: { type: "string" } },
                max_bytes: { type: "number", description: `Page size. Default ${DEFAULT_PAGE_BYTES}, max ${MAX_PAGE_BYTES}.` },
                cursor: { type: "string" }
            }
        },
        // ⚠️ Claude Code moves a tool result over its limit (25,000 tokens by default)
        // into a file. A page is sized by the CALLER, so the tool declares the
        // largest page it can return and the client keeps it in the conversation.
        _meta: { "anthropic/maxResultSizeChars": MAX_PAGE_BYTES + 100_000 }
    }
];

export const READ_TOOL_NAMES = READ_TOOLS.map((t) => t.name);

// ⚠️ CONDITIONAL ON PURPOSE (2.4.1). "Prefer read_documents" unqualified would send a model to
// read a 260,000-token shelf to answer a one-fact question — slower, costlier and often worse.
// ⛔ It names shelves by their facets (list_documents' own vocabulary), never by what the
// documents say: describing the API, not the subject matter.
export const READ_INSTRUCTIONS =
    " For a broad question, read the relevant shelf in full: choose it with list_documents, read it with " +
    "read_documents. Search returns excerpts, suited to finding one passage. Every document ends with an " +
    "[END OF DOCUMENT] line; if it is missing, the text was cut short.";

/**
 * list_documents' pointer to reading what it just listed: the same filters, as arguments
 * read_documents accepts. Only the facets actually given, so the pointer reads back exactly.
 */
export const readWith = (args, count) =>
    count
        ? {
              tool: "read_documents",
              arguments: Object.fromEntries(["genre", "category", "voice", "licence"].filter((k) => args?.[k]).map((k) => [k, args[k]])),
              note: "Reads every document listed here in full, paged by size."
          }
        : null;

// ⚠️ The cursor carries the INDEX VERSION as well as the offset. Pages are offsets
// into a list, and a list read across a redeploy is two lists: without the version
// a caller could be handed page 2 of a different corpus and never know.
const encodeCursor = (version, offset) => btoa(`${version}:${offset}`);
const decodeCursor = (cursor, version) => {
    let raw;
    try {
        raw = atob(String(cursor));
    } catch {
        throw new Error(`invalid cursor: ${cursor}`);
    }
    const at = raw.lastIndexOf(":");
    const v = raw.slice(0, at);
    const offset = Number(raw.slice(at + 1));
    if (at < 0 || !Number.isInteger(offset) || offset < 0) throw new Error(`invalid cursor: ${cursor}`);
    if (v !== version) {
        throw new Error(`this cursor belongs to corpus ${v}, and the server now serves ${version}. Start again without a cursor.`);
    }
    return offset;
};

/**
 * read_documents. `ctx` is what differs between the surfaces:
 * { documents, bySlug, version }.
 */
export const readDocuments = ({ documents, bySlug, version }, args) => {
    const hasFilter = ["genre", "category", "voice", "licence"].some((k) => args?.[k]);
    let matched;
    if (args?.slugs !== undefined) {
        if (hasFilter) throw new Error("give slugs or filters, not both.");
        if (!Array.isArray(args.slugs) || !args.slugs.length) throw new Error("slugs must be a non-empty array of document slugs.");
        const slugs = [...new Set(args.slugs.map(String))];
        const unknown = slugs.filter((s) => !bySlug.has(s));
        if (unknown.length) throw new Error(`no document with slug ${unknown.map((s) => `"${s}"`).join(", ")}. Call list_documents to see what is available.`);
        matched = slugs.map((s) => bySlug.get(s));
    } else {
        matched = filterDocuments(documents, args);
    }

    const budget = args?.max_bytes === undefined ? DEFAULT_PAGE_BYTES : Number(args.max_bytes);
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("max_bytes must be a positive number.");
    if (budget > MAX_PAGE_BYTES) throw new Error(`max_bytes may be at most ${MAX_PAGE_BYTES}; follow next_cursor for the rest.`);

    const start = args?.cursor ? decodeCursor(args.cursor, version) : 0;
    if (start > matched.length) throw new Error(`invalid cursor: ${args.cursor}`);

    // Whole documents only. ⛔ A document is never split across pages: its hash, its
    // header and its end marker describe the whole, and half of one verifies nothing.
    // So a document larger than the budget arrives alone, over budget, and says so.
    const page = [];
    let used = 0;
    for (let i = start; i < matched.length; i++) {
        const text = documentText(matched[i]);
        const size = byteLength(text);
        if (page.length && used + size > budget) break;
        page.push({ d: matched[i], text, size });
        used += size;
    }
    const nextOffset = start + page.length;
    const next = nextOffset < matched.length ? encodeCursor(version, nextOffset) : undefined;

    if (!matched.length) {
        return { content: [{ type: "text", text: "no documents match these filters. Call list_documents to see the facets and their counts." }] };
    }

    // ⛔⛔ TEXT ONLY — NO structuredContent (2.4.2, founder-ruled 2026-09-13). A Claude client shown a
    // result that carries structuredContent hands its model ONLY that part; the envelope-without-body
    // shape this tool shipped with in 2.4.0 therefore delivered no document to any Claude-based reader
    // (§the-text-never-arrived). The document IS the payload, and the provenance already rides in each
    // document's header, so the structured copy bought validation for programs at the price of the
    // text for models. Everything a reader needs to keep going is in the [PAGE] line.
    const content = page.map((p) => ({ type: "text", text: p.text }));
    const over = page.length === 1 && used > budget ? " This document is larger than max_bytes and was returned whole rather than split." : "";
    content.push({
        type: "text",
        text: next
            ? `[PAGE — documents ${start + 1}–${nextOffset} of ${matched.length}.${over} ${matched.length - nextOffset} more: call read_documents again with the same arguments and cursor "${next}".]`
            : `[PAGE — documents ${start + 1}–${nextOffset} of ${matched.length}.${over} That is every matching document.]`
    });
    return { content };
};

/**
 * get_document — shared by both surfaces since 2.4.2, TEXT ONLY for the same reason as read_documents:
 * the envelope-without-body in structuredContent was the only part a Claude client showed its model.
 */
export const getDocument = ({ bySlug }, args) => {
    const d = bySlug.get(String(args?.slug ?? ""));
    if (!d) throw new Error(`no document with slug "${args?.slug}". Call list_documents to see what is available.`);
    return { content: [{ type: "text", text: documentText(d) }] };
};

/**
 * list_documents' completeness block: the manifest's counts and the reasons, so the
 * listing a caller already has is checkable against what the build considered.
 */
export const completenessOf = (corpus) =>
    corpus.manifest
        ? {
              candidates: corpus.manifest.candidates,
              served: corpus.manifest.served,
              excluded: corpus.manifest.excluded_documents,
              held: corpus.manifest.held_documents,
              note: "An unfiltered listing should name every served document; the full manifest is at https://corpus.333.eco/manifest.json."
          }
        : null;

/**
 * ⛔ What both surfaces check before serving anything: do the documents loaded match
 * the manifest the build wrote? Returns the problems; empty means serve.
 * ⚠️ An index built before the manifest existed has none, and that is not refused —
 * it is the previous release, not a damaged one.
 */
export const manifestProblems = (corpus) => {
    const m = corpus.manifest;
    if (!m) return [];
    const problems = [];
    if (m.candidates !== m.served + m.excluded + m.held) {
        problems.push(`manifest does not reconcile: ${m.candidates} candidates vs ${m.served} + ${m.excluded} + ${m.held}`);
    }
    if (corpus.documents.length !== m.served) {
        problems.push(`${corpus.documents.length} documents loaded, manifest names ${m.served}`);
    }
    const loaded = new Map(corpus.documents.map((d) => [d.slug, d.provenance?.sha256]));
    for (const s of m.served_documents ?? []) {
        if (!loaded.has(s.slug)) problems.push(`manifest names "${s.slug}", which is not loaded`);
        else if (loaded.get(s.slug) !== s.sha256) problems.push(`"${s.slug}" does not carry the sha256 the manifest records`);
    }
    return problems;
};
