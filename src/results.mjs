// How a tool result is shaped.
//
// ⭐⭐ TWO SHAPES, CHOSEN BY WHAT THE TOOL RETURNS.
//
//     metadata tools (search, list, program)  — structuredContent: the typed object, plus a
//                                               readable or compact `content`
//     document tools (get_document, read_documents) — `content` ONLY: each document behind its
//                                               provenance header (read-tools.mjs); never these helpers
//
// ⛔⛔ WHY THE DOCUMENT TOOLS DO NOT USE THIS FILE (2.4.2, founder-ruled 2026-09-13). From 2.0.0 this file
// "split by role": document text in `content`, the envelope WITHOUT THE BODY in `structuredContent`,
// nothing sent twice. A Claude client shown a result that carries structuredContent hands its model ONLY
// that part — so no document text reached any Claude reader for eleven days, while every check passed
// because every check read the server, never a client. The spec assumes both parts carry the same
// information; a server that splits them is at the mercy of whichever part a client picks.
// ⛔ So for a METADATA tool, everything a reader needs must be in structuredContent (search's `reading`
// line rides there for that reason). ⛔ NEVER give a document tool structuredContent again —
// scripts/check-parity.mjs fails on it. Retirement recorded in TH/notes/memory/retired-rulings.md.
//
// ⚠️ THE SPEC'S BACK-COMPAT ADVICE — also serialise the JSON into `content` — DOUBLES a response
// (measured 1.76×–2.00×). For the metadata tools `content` is therefore a compact serialisation or a
// readable summary, not a second copy of a large body. ⛔ No `outputSchema` yet: the spec makes a
// declared schema binding, and a schema over a moving shape breaks validating clients later.

// A payload that is data all the way down: the object, plus a COMPACT serialisation
// for clients that read only `content`. Compact, not pretty — indentation is the
// one part of the old shape that was pure cost.
export const structured = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
});

// A metadata payload with a human form: `text` is read, `value` is validated. ⛔ Anything a model
// needs must be in `value` too — a Claude client shows its model only `value`.
export const structuredWithText = (text, value) => ({
    content: [{ type: "text", text }],
    structuredContent: value
});
