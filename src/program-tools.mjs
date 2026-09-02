// The research-program tools, shared by both surfaces.
//
// ⭐ WHY THIS IS A MODULE AND THE ENVELOPE IS NOT. The envelope is deliberately
// duplicated between the stdio server and the worker "so the two can be diffed by
// eye". That argument works for twenty lines of object literal. It does not work
// for a tool surface: these three tools are ~120 lines of filtering, fallback and
// wording, and a hand-maintained second copy of that is how corpus.333.eco ends up
// advertising tools the npm package does not have, or worse, answering the same
// question differently. The repo already refuses to let the two surfaces disagree
// about what a DOCUMENT says; this is the same refusal applied to what a TOOL says.
//
// ⚠️ The envelope is INJECTED rather than imported, so each surface keeps its own
// — that duplication is intentional and is not undone here.
//
// ⚠️ Only bundles JavaScript. The corpus itself stays a static asset in the worker
// (1.61 MB gzipped, over the script cap); this module is a few kilobytes of logic.

import { READ_ONLY } from "./base-tools.mjs";
import { structured } from "./results.mjs";

export const PROGRAM_TOOLS = [
    {
        name: "list_predictions",
        title: "List the pre-registered predictions",
        annotations: { ...READ_ONLY, title: "List the pre-registered predictions" },
        description:
            "List the pre-registered predictions of the Which Way Value Moves research program, with each one's " +
            "registered falsifier and current status. Filterable by state, chapter, level and stating paper. Use to " +
            "find what would falsify a claim, or what has actually been run — the program registers what could show " +
            "it wrong, so an unrun prediction is a disclosure, not a gap.",
        inputSchema: {
            type: "object",
            properties: {
                state: { type: "string", description: "Optional facet: unrun, running, run, contradicted, retired, other. The verbatim status is always returned beside it." },
                chapter: { type: "string", description: "Optional, matched as a substring: e.g. \"Core-level\", \"Scale\"." },
                level: { type: "string", description: "Optional: core (failing one ends the program) or chapter." },
                paper: { type: "string", description: "Optional: slug of the stating paper, e.g. co-presence-gated-redemption." }
            }
        }
    },
    {
        name: "get_prediction",
        title: "Read one prediction, with its paper's proof",
        annotations: { ...READ_ONLY, title: "Read one prediction, with its paper's proof" },
        description:
            "Return one pre-registered prediction by identifier (e.g. P-L2) with its registered wording, its " +
            "falsifier, its status, and the PROVENANCE ENVELOPE OF THE PAPER THAT REGISTERED IT — hash, DOI and " +
            "OpenTimestamps command — so the registration itself can be verified rather than trusted.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "Prediction identifier, e.g. P-L2, P-K1, P-CS5." } },
            required: ["id"]
        }
    },
    {
        name: "get_program",
        title: "The research program in one call",
        annotations: { ...READ_ONLY, title: "The research program in one call" },
        description:
            "The shape of the research program in one call: its hard core, its four chapters, its stopping rule, its " +
            "revision rule and its own count reconciliation — all verbatim, drawn from the two documents that state " +
            "it, with both provenance envelopes attached. Use to orient before querying predictions.",
        inputSchema: { type: "object", properties: {} }
    }
];

export const PROGRAM_TOOL_NAMES = PROGRAM_TOOLS.map((t) => t.name);

export const PROGRAM_INSTRUCTIONS =
    " This corpus also carries a research program with a public register of falsifiable predictions: " +
    "list_predictions, get_prediction and get_program expose what would show the program wrong and what has " +
    "actually been run. A prediction's authority is the paper that registered it, so those tools return that " +
    "paper's provenance envelope rather than the register's.";

// A prediction as returned: the record, plus its stating paper resolved to a real
// envelope. ⚠️ `stating_paper` gains nothing where the register itself is the
// origin, or where the row names no paper — never silently filled in.
const view = (p, bySlug, envelope) => {
    const paper = p.stating_paper.slug ? bySlug.get(p.stating_paper.slug) : null;
    return {
        ...p,
        stating_paper: {
            ...p.stating_paper,
            ...(paper
                ? {
                      title: paper.title,
                      // The whole point: verify the registration against the paper
                      // that made it, not against the index that lists it.
                      provenance: envelope(paper).provenance,
                      full_text: `call get_document with slug "${paper.slug}"`
                  }
                : {})
        }
    };
};

export const callProgramTool = ({ program, bySlug, envelope }, name, args) => {
    if (!program) throw new Error("this index carries no research program block");

    if (name === "list_predictions") {
        const eq = (a, b) => !b || String(b).toLowerCase() === String(a ?? "").toLowerCase();
        const hits = program.predictions.filter(
            (p) =>
                eq(p.state, args?.state) &&
                eq(p.level, args?.level) &&
                (!args?.chapter || p.chapter.toLowerCase().includes(String(args.chapter).toLowerCase())) &&
                eq(p.stating_paper.slug, args?.paper)
        );
        return structured({
            question: program.question,
            matched: hits.length,
            of: program.prediction_count,
            // ⚠️ RETURNED ON EVERY LIST, UNFILTERED, because a set of predictions
            // means nothing without the honest denominator beside it: this program
            // has 2 run, both desk censuses, and 0 field tests. A caller shown only
            // its own filter could read a long list as a body of evidence.
            by_state: program.predictions.reduce((a, x) => ((a[x.state] = (a[x.state] ?? 0) + 1), a), {}),
            predictions: hits.map((p) => view(p, bySlug, envelope))
        });
    }

    if (name === "get_prediction") {
        const id = String(args?.id ?? "").trim();
        const hit = program.predictions.find((x) => x.id && x.id.toLowerCase() === id.toLowerCase());
        if (hit) return structured(view(hit, bySlug, envelope));

        // ⭐ A WITHHELD PREDICTION IS ANSWERED, NOT DENIED. The register publishes
        // the identifier and the reason precisely so the total is honest; a lookup
        // that said "no such prediction" would undo that on the server's side.
        const w = program.withheld.find((x) => x.id.toLowerCase() === id.toLowerCase());
        if (w) {
            return structured({
                id: w.id,
                withheld: true,
                reason: w.reason,
                note: "Recorded in the register so the total is honest; the wording is not published."
            });
        }
        const out = program.instrumented_outside_core.find((x) =>
            x.ids.split(/,\s*/).map((s) => s.trim().toLowerCase()).includes(id.toLowerCase())
        );
        if (out) {
            return structured({
                id,
                outside_core: true,
                paper: out.paper,
                subject: out.subject,
                note: "Named by a paper but testing something other than the direction core — not evidence for or against the program."
            });
        }
        throw new Error(`no prediction "${id}". Call list_predictions to see the register, or get_program for its shape.`);
    }

    if (name === "get_program") {
        return structured({
            question: program.question,
            documents: program.documents.map((slug) => {
                const d = bySlug.get(slug);
                return d ? { ...envelope(d), full_text: `call get_document with slug "${slug}"` } : { slug };
            }),
            hard_core: program.hard_core,
            four_chapters: program.four_chapters,
            chapters: program.chapters,
            honest_limits: program.honest_limits,
            stopping_rule: program.stopping_rule,
            revision_rule: program.revision_rule,
            verification: program.verification,
            counts: program.counts,
            // The register's arithmetic, re-derived from its own tables at build
            // time rather than copied from its Summary.
            reconciliation: program.reconciliation,
            withheld: program.withheld,
            instrumented_outside_core: program.instrumented_outside_core,
            // ⚠️ Surfaced, never buried: an attribution the builder could not
            // confirm against the paper it names.
            unverified_attributions: program.unverified_attributions
        });
    }

    throw new Error(`unknown program tool: ${name}`);
};
