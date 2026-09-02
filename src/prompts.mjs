// Prompts — worked examples of how to use this server, shared by both surfaces.
//
// ⛔⛔ THE GUARD, AND IT IS THE WHOLE REASON THESE ARE SAFE TO SHIP: A PROMPT HERE
// MAY DESCRIBE THE API. IT MAY NEVER DESCRIBE THE SUBJECT MATTER. The moment one
// of these says something about gratitude, the gift, the four bodies or what the
// research program has shown, this server has begun editorialising on its own
// corpus — and a retrieval server with opinions about its documents is exactly the
// thing the provenance envelope exists to make unnecessary. Read every line below
// as an answer to "how do I check this?" and never to "what should I conclude?"
//
// ⚠️ A SECOND, NARROWER REFUSAL, recorded because it was the tempting version:
// there is no `verify_before_citing` prompt telling a model to behave well. That
// would be a RULE where the server already has a PROPERTY — every document, by
// every route, arrives with a provenance header the reader must actively strip.
// A rule that fires only when a human picks it from a menu is the weak form of a
// guarantee that already fires always. These prompts demonstrate the API; they do
// not ask anyone to be careful.

export const PROMPTS = [
    {
        name: "orient",
        title: "What is in this corpus?",
        description:
            "A worked example of the discovery tools: what genres and topic categories exist, how many documents " +
            "carry proofs, and where the research program's own statement of itself lives. Calls tools; asserts nothing.",
        arguments: []
    },
    {
        name: "verify_a_quote",
        title: "Check a quotation against its source",
        description:
            "A worked example of the verification path: fetch a document, then check the served text against the " +
            "hash, the DOI and the OpenTimestamps proof its envelope names. Shows what to run, not what to believe.",
        arguments: [
            { name: "slug", description: "Document slug, e.g. co-presence-gated-redemption. Completable.", required: true },
            { name: "quote", description: "Optional: the passage you intend to cite.", required: false }
        ]
    },
    {
        name: "what_would_falsify",
        title: "Find what would show a claim wrong",
        description:
            "A worked example of the program tools: search the prediction register for the registered falsifier of a " +
            "claim, then resolve it to the paper that registered it and verify THAT paper. Demonstrates the one " +
            "non-obvious move in this API — a prediction's authority is its stating paper, not the register.",
        arguments: [{ name: "claim", description: "The claim or topic you want to test, in your own words.", required: true }]
    }
];

export const PROMPT_NAMES = PROMPTS.map((p) => p.name);

const message = (text) => ({ role: "user", content: { type: "text", text } });

export const getPrompt = (name, args) => {
    if (name === "orient") {
        return {
            description: "Discover the shape of the corpus using its own tools.",
            messages: [
                message(
                    "Show me what this corpus contains, using the server's tools rather than your prior knowledge.\n\n" +
                        "1. Call list_documents with no arguments. Report the total, the licence split, and the `categories` map — " +
                        "those are the corpus's own shelves, and `institutional` is where the institution describes itself.\n" +
                        "2. Call list_documents with category \"institutional\" and list what is there.\n" +
                        "3. Call get_program to see the research program's own statement of its hard core, its chapters and its " +
                        "count reconciliation.\n\n" +
                        "Quote the documents' own words where you summarise them, and name the slug you took each claim from. " +
                        "Do not fill gaps from memory: if the corpus does not cover something, say that it does not."
                )
            ]
        };
    }

    if (name === "verify_a_quote") {
        const slug = String(args?.slug ?? "").trim();
        if (!slug) {
            const e = new Error("verify_a_quote requires a `slug` argument");
            e.code = -32602;
            throw e;
        }
        const quote = String(args?.quote ?? "").trim();
        return {
            description: `Verify a passage of ${slug} against its anchored proof.`,
            messages: [
                message(
                    `Check a quotation from \`${slug}\` against its source, using this server's provenance envelope.\n\n` +
                        `1. Call get_document with slug "${slug}". The document arrives in content[0].text behind a ` +
                        "[PROVENANCE] header; the typed envelope is in structuredContent.\n" +
                        (quote
                            ? `2. Find this passage in the text and report whether it appears verbatim:\n\n   "${quote}"\n\n`
                            : "2. Choose the passage you intend to cite and report it verbatim.\n\n") +
                        "3. Run the envelope's own `verify.sha256` command and compare the result with `provenance.sha256`. " +
                        "Report whether they match, and note that the hash covers the complete source file — metadata block " +
                        "included — and not the body alone.\n" +
                        "4. If `provenance.doi` is present, give the DOI to cite. If the document's status is `living`, cite " +
                        "the concept DOI and verify against the version DOI, as the envelope's `citation` block says.\n" +
                        "5. If `licence.attribution_required` is true, name whom to attribute.\n\n" +
                        "Report what the commands actually returned. Do not vouch for the text on the server's behalf."
                )
            ]
        };
    }

    if (name === "what_would_falsify") {
        const claim = String(args?.claim ?? "").trim();
        if (!claim) {
            const e = new Error("what_would_falsify requires a `claim` argument");
            e.code = -32602;
            throw e;
        }
        return {
            description: "Find the registered falsifier for a claim, and verify where it was registered.",
            messages: [
                message(
                    `Find out what would show this claim wrong, according to the corpus's own prediction register:\n\n` +
                        `   "${claim}"\n\n` +
                        "1. Call list_predictions and look for predictions bearing on it. `by_state` is returned unfiltered — " +
                        "report it, because a long list of predictions is not a body of evidence.\n" +
                        "2. For the closest match, call get_prediction with its id. Report the registered wording, the " +
                        "registered falsifier, and the status verbatim.\n" +
                        "3. ⭐ The result's `stating_paper` carries the envelope of the PAPER that registered the prediction, " +
                        "not of the register. That is deliberate: the register says to verify the stating paper against its " +
                        "stored proof rather than to trust the register. Follow that — verify the stating paper.\n" +
                        "4. Say plainly whether the prediction has been run. An unrun prediction is a disclosure, not a result, " +
                        "and must not be reported as evidence either way.\n\n" +
                        "If no registered prediction bears on the claim, say so rather than constructing one."
                )
            ]
        };
    }

    const e = new Error(`no prompt "${name}". Call prompts/list to see what is available.`);
    e.code = -32602;
    throw e;
};
