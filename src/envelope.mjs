// The provenance envelope — attached to every document a tool returns, on both surfaces.
//
// `verify` is the instruction rather than a promise: it tells the agent exactly what
// to run, so the claim is checkable without trusting this sentence either.
//
// ⚠️⚠️ IT WAS WRITTEN TWICE, ON PURPOSE, AND THE PURPOSE FAILED. Each server kept its own
// copy "so the two can be diffed by eye; if they ever disagree, that is a bug in one of
// them and the diff is where it shows." They did disagree — the OpenTimestamps
// instruction and the revised-since-deposit note had different wording on the two
// surfaces — and no eye caught it. The first check that COMPARED THE ANSWERS did, on its
// first run (2026-09-13). A rule that depends on someone looking is replaced by one
// function both surfaces import: the difference can no longer be written.

export const envelope = (d) => ({
    slug: d.slug,
    title: d.title,
    licence: {
        id: d.licence.id,
        url: d.licence.url,
        attribution_required: d.licence.attribution_required,
        // Only present where it is actually owed, so an agent can act on the
        // field's presence rather than parsing the licence id.
        ...(d.licence.attribution_required && d.authors ? { attribute_to: d.authors } : {})
    },
    provenance: {
        ...d.provenance,
        // ⚠️ A LIVING DOCUMENT IS VERIFIED AND CITED WITH DIFFERENT DOIs, and
        // saying only "cite accordingly" leaves the reader to guess which.
        // The VERSION doi is the only one that can be true of the bytes here
        // — it pins them — so it is what a hash check resolves against. The
        // CONCEPT doi follows the document, so it is what a citation should
        // name: a living register is revised on purpose, and a citation
        // pinned to one revision goes stale by design rather than by accident.
        ...(d.status === "living" && d.provenance.concept_doi
            ? {
                  citation: {
                      cite: `https://doi.org/${d.provenance.concept_doi}`,
                      verify_against: d.provenance.doi ? `https://doi.org/${d.provenance.doi}` : null,
                      why: "This document is living — it is revised on purpose. Cite the concept DOI, which always resolves to the newest version; verify the text you were served against the version DOI and sha256 above, which pin these exact bytes."
                  }
              }
            : {}),
        verify: {
            // Concrete, because an instruction that says "the source file"
            // without saying which one is not an instruction. All three source
            // repositories are public, so this is genuinely runnable.
            sha256: d.provenance.source_url
                ? `curl -sL ${d.provenance.source_url} | shasum -a 256   # compare to provenance.sha256`
                : "shasum -a 256 <the source file>   # compare to provenance.sha256",
            ...(d.provenance.doi ? { doi: `https://doi.org/${d.provenance.doi}` } : {}),
            ...(d.provenance.opentimestamps
                ? { opentimestamps: `ots verify ${d.path}.ots  # in the source repository; the proof is anchored in the Bitcoin blockchain` }
                : {}),
            ...(d.provenance.deposited_matches_current === false
                ? {
                      note:
                          "This document has been REVISED since its Zenodo deposit, so provenance.sha256 " +
                          "and provenance.deposited_sha256 differ legitimately. The DOI resolves to the " +
                          "deposited version; the text served here is newer. Cite accordingly."
                  }
                : {})
        }
    }
});
