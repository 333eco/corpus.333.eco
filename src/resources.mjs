// MCP resources over the corpus — shared by both surfaces.
//
// ⭐⭐ THE ONE DECISION THAT SHAPES THIS FILE: A RESOURCE CARRIES ITS PROVENANCE
// IN THE TEXT, NOT BESIDE IT. A tool response wraps a document in an envelope and
// a caller reads the envelope. A resource is different in kind — clients hand its
// contents straight to a model as context, and a `mimeType` field does not travel
// with a quotation. Serving bare text here would hand out corpus material stripped
// of the one property this server exists to provide.
//
// ⚠️ This is not a new judgement; it is the letters' rule applied a second time.
// The letters mark voice INLINE — "[VERBATIM — Thon Ly]" / "[SCAFFOLD …]" — rather
// than in a metadata field, because *with a field an agent must LOOK to know; with
// a marker it must STRIP not to*. The same asymmetry decides this: a header the
// model must delete is safe, a field it must consult is not.
//
// ⚠️⚠️ AND THE HEADER MUST SAY WHAT THE HASH DOES NOT COVER. `provenance.sha256`
// is computed over the whole source file, front matter included; `text` is the
// body. Prepending a header makes the served bytes hash to nothing at all — so
// the header states plainly that it is not part of the hashed artifact and points
// at the file that is. A "verifiable" resource that quietly cannot be verified
// would be worse than one that never claimed it.

const CORPUS_SCHEME = "corpus://";
const PAGE = 50;

export const RESOURCE_TEMPLATES = [
    {
        uriTemplate: "corpus://{slug}",
        name: "corpus-document",
        title: "Corpus document by slug",
        description:
            "Any document in the corpus, addressed by its slug — e.g. corpus://co-presence-gated-redemption. " +
            "Returns the canonical text prefixed with a provenance header carrying its licence, sha256, DOI and " +
            "a runnable verification command. Slugs come from resources/list or the list_documents tool.",
        mimeType: "text/markdown"
    }
];

const mime = (d) => (d.metadata_convention === "html" ? "text/plain" : "text/markdown");

// The catalogue entry. Deliberately terse: a client renders this in a picker, and
// the licence is the one thing a person choosing a document needs to see.
export const resourceEntry = (d) => ({
    uri: CORPUS_SCHEME + d.slug,
    name: d.slug,
    title: d.title,
    description:
        `${d.genre} · ${d.licence.id}` +
        (d.date ? ` · ${d.date}` : "") +
        (d.provenance.doi ? ` · doi:${d.provenance.doi}` : "") +
        (d.subtitle ? ` — ${d.subtitle}` : ""),
    mimeType: mime(d),
    // ⚠️ `lastModified` carries the document's own date and NOTHING MORE PRECISE.
    // ISO 8601 permits a date alone, and inventing "T00:00:00Z" would assert a
    // time this corpus does not record — a small lie in a provenance server.
    annotations: {
        audience: ["user", "assistant"],
        // Anchored papers rank above unanchored scaffold: a consumer choosing
        // among 140 documents should meet the ones with proofs first.
        priority: d.provenance.doi ? 0.9 : d.provenance.opentimestamps ? 0.6 : 0.4,
        ...(d.date ? { lastModified: d.date } : {})
    }
});

export const listResources = (documents, cursor) => {
    // Cursor-based paging, because a corpus grows and a client should not have to
    // take 140 entries to find one. The cursor is an offset encoded as a string —
    // opaque to the client, which is all the protocol asks of it.
    // ⚠️ btoa/atob, NOT Buffer. The worker runs without nodejs_compat, so Buffer is
    // undefined there and only there — a break that passes every local test and
    // fails once, in production, on the surface nobody runs by hand.
    let start = 0;
    if (cursor) {
        try {
            start = Number(atob(String(cursor)));
        } catch {
            throw new Error(`invalid cursor: ${cursor}`);
        }
    }
    if (!Number.isInteger(start) || start < 0 || start > documents.length) {
        throw new Error(`invalid cursor: ${cursor}`);
    }
    const page = documents.slice(start, start + PAGE);
    const next = start + PAGE < documents.length ? btoa(String(start + PAGE)) : undefined;
    return { resources: page.map(resourceEntry), ...(next ? { nextCursor: next } : {}) };
};

// ⚠️ Attribution is stated as an instruction, not a licence id. CC-BY on seven of
// these documents means a real obligation, and "CC-BY-4.0" alone leaves an agent
// to know what that entails.
const licenceLine = (d) =>
    d.licence.attribution_required
        ? `${d.licence.id} — ATTRIBUTION REQUIRED. Attribute to: ${d.authors ?? "⚠️ UNKNOWN — the index carries no author for this document; do not quote it until that is fixed"}. ${d.licence.url}`
        : `${d.licence.id} — no attribution required, though citation is welcome. ${d.licence.url}`;

export const provenanceHeader = (d) => {
    const p = d.provenance;
    const L = [];
    L.push("[PROVENANCE — corpus.333.eco. This header is NOT part of the document; the document begins below.]");
    L.push(`title:   ${d.title}`);
    L.push(`slug:    ${d.slug}   (${d.genre}${d.date ? `, ${d.date}` : ""})`);
    L.push(`licence: ${licenceLine(d)}`);
    if (p.source_url) L.push(`source:  ${p.source_url}`);
    if (p.canonical_url) L.push(`canonical: ${p.canonical_url}`);
    L.push(`sha256:  ${p.sha256}`);
    // The single most misreadable field, so it gets a full sentence.
    L.push("         ⚠️ covers the COMPLETE SOURCE FILE at `source`, metadata block included —");
    L.push("            NOT the text below, and NOT this header. Hashing what you were served");
    L.push("            will not reproduce it. Fetch `source` to check.");
    if (p.doi) L.push(`doi:     https://doi.org/${p.doi}   (this exact version)`);
    if (p.concept_doi) L.push(`concept: https://doi.org/${p.concept_doi}   (follows the document across versions)`);
    if (p.opentimestamps) L.push(`proof:   ots verify ${d.path}.ots   — in the source repository, anchored in Bitcoin`);
    if (p.source_url) L.push(`verify:  curl -sL ${p.source_url} | shasum -a 256   # compare with sha256 above`);

    if (p.deposited_matches_current === false) {
        L.push("status:  ⚠️ REVISED SINCE ITS DEPOSIT. The DOI above resolves to the deposited");
        L.push("            version; the text below is newer. They differ legitimately.");
    }
    if (d.status === "living" && p.concept_doi) {
        L.push("living:  This document is revised on purpose. CITE the concept DOI, which always");
        L.push("            resolves to the newest version; VERIFY against the version DOI and");
        L.push("            sha256 above, which pin these exact bytes.");
    }
    // ⚠️ The letters' inline voice markers are meaningless without the sentence
    // that explains them, and that sentence lives in `editorial` — a field a
    // resource read would otherwise drop, reintroducing the exact bug the tool
    // responses were once shipped with.
    if (d.editorial?.annotation) {
        L.push(`editorial: ${d.editorial.annotation.replace(/\s+/g, " ")}`);
    }
    L.push("[END PROVENANCE — everything below this line is the document, verbatim.]");
    return L.join("\n");
};

export const readResource = (uri, bySlug) => {
    const raw = String(uri ?? "");
    if (!raw.startsWith(CORPUS_SCHEME)) {
        throw new Error(`unsupported resource uri "${raw}". Corpus documents are addressed as corpus://<slug>.`);
    }
    const slug = raw.slice(CORPUS_SCHEME.length);
    const d = bySlug.get(slug);
    if (!d) throw new Error(`no document with slug "${slug}". Call resources/list to see what is available.`);
    return {
        contents: [
            {
                uri: raw,
                mimeType: mime(d),
                // Header, blank line, then the document exactly as the tools return it.
                text: provenanceHeader(d) + "\n\n" + d.text
            }
        ]
    };
};

/* ------------------------------------------------------------- completions ---
   ⭐ A URI TEMPLATE WITHOUT COMPLETION IS A TEMPLATE YOU MUST ALREADY KNOW THE
   ANSWER TO USE. `corpus://{slug}` is only usable by someone who already has the
   slug; this is what turns it into something a person can discover by typing.

   ⚠️ Prefix matches rank above substring matches, because a slug is a name and a
   person typing one is almost always typing its beginning. Within each group the
   order is the corpus's own (alphabetical by slug) — stable, so the same keystroke
   never reorders the list under the user's cursor. */

const COMPLETION_MAX = 100; // the spec's ceiling

const slugCompletion = (value, documents) => {
    const q = String(value ?? "").toLowerCase();
    const slugs = documents.map((d) => d.slug);
    const starts = slugs.filter((s) => s.startsWith(q));
    const contains = q ? slugs.filter((s) => !s.startsWith(q) && s.includes(q)) : [];
    const all = [...starts, ...contains];
    return {
        completion: {
            values: all.slice(0, COMPLETION_MAX),
            total: all.length,
            hasMore: all.length > COMPLETION_MAX
        }
    };
};

export const completeArgument = (ref, argument, documents) => {
    // ⭐ Prompts and completions compose: `verify_a_quote` takes a slug, and the
    // same slug list that completes corpus://{slug} completes it here. A prompt
    // argument nobody can autocomplete is a prompt you must already know how to
    // fill in — the same defect the resource template had before completions.
    if (ref?.type === "ref/prompt") {
        if (ref.name === "verify_a_quote" && argument?.name === "slug") {
            return slugCompletion(argument?.value, documents);
        }
        const e = new Error(
            `no completions for prompt "${ref?.name}" argument "${argument?.name}". ` +
                "The completable prompt argument is verify_a_quote(slug)."
        );
        e.code = -32602;
        throw e;
    }
    if (ref?.type !== "ref/resource") {
        const e = new Error(`unsupported completion reference type "${ref?.type}"`);
        e.code = -32602;
        throw e;
    }
    if (ref.uri !== "corpus://{slug}") {
        const e = new Error(`no completions for "${ref.uri}". The completable template is corpus://{slug}.`);
        e.code = -32602;
        throw e;
    }
    if (argument?.name !== "slug") {
        const e = new Error(`corpus://{slug} has one argument, "slug"; got "${argument?.name}"`);
        e.code = -32602;
        throw e;
    }

    return slugCompletion(argument?.value, documents);
};
