// How a tool result is shaped.
//
// ⭐⭐ JSON IS THE PAYLOAD; THE TEXT BLOCK IS THE HUMAN FORM. Until 2026-09-02 every
// tool returned pretty-printed JSON inside a text block, which meant a consuming
// program had to parse a string to reach data the server already had as an object.
// `structuredContent` is where that object belongs.
//
// ⚠️ THE SPEC'S BACK-COMPAT ADVICE — also serialise the JSON into `content` — is a
// SHOULD, and following it literally DOUBLES every response (measured: 1.76×–2.00×
// across the six tools). So this file does not duplicate. It SPLITS BY ROLE:
//
//     content            — what a reader reads: document text, excerpts, a listing
//     structuredContent  — what a program validates: the typed envelope and metadata
//
// Nothing appears in both. For the document tools that makes `content` the text
// WITH ITS PROVENANCE HEADER — identical to what resources/read returns, so the two
// ways into the same document finally agree — and `structuredContent` the envelope
// without the body. Measured cost: 1.00× on the large tools, 0.76×–0.78× on the
// metadata tools, which are smaller than what they replaced.
//
// ⛔ NO `outputSchema` YET, and that is a decision rather than an omission. The spec
// makes a declared schema binding — "servers MUST provide structured results that
// conform" — and the envelope changed twice on the day this was written. A schema
// is a promise kept on every future change; publishing one over a shape still in
// motion buys validation now and breaks validating clients later.

// A payload that is data all the way down: the object, plus a COMPACT serialisation
// for clients that read only `content`. Compact, not pretty — indentation is the
// one part of the old shape that was pure cost.
export const structured = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
});

// A payload with a human form: `text` is read, `value` is validated, and the two
// carry different things rather than the same thing twice.
export const structuredWithText = (text, value) => ({
    content: [{ type: "text", text }],
    structuredContent: value
});
