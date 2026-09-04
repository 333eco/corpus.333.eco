// `--report-gap` and `--report-bug` — the only place this package makes an
// outbound request, and it is reached only by typing one of the flags.
//
// ⭐⭐ WHY THIS IS A COMMAND AND NOT TELEMETRY, because the distinction is the
// whole design. The useful signal from a corpus server is *what someone looked
// for and did not find*. The remote endpoint at corpus.333.eco collects that
// from its own callers as a property of being the server they called. This
// package runs on YOUR machine, so the same collection there would be an
// outbound report about your private reading — and the guard against that is
// not a consent flag or an opt-out. It is that THE SERVER PATH CANNOT REACH
// THIS FILE: `server.mjs` loads it with a dynamic import inside the argv branch,
// so during normal operation the module is never even read off disk.
//
// ⚠️ THE CHECKABLE CLAIM CHANGED SHAPE WHEN THIS FILE WAS ADDED, AND THAT IS
// WORTH STATING PLAINLY. Before it, "this package makes no network call" was
// verifiable by `grep -r fetch src/` returning nothing at all — the strongest
// kind of evidence, because it needs no reasoning. Now the honest claim is
// narrower: there is exactly ONE fetch in the package, it lives in this file,
// and this file is imported from exactly one place — a branch that requires an
// explicit flag. Still inspectable in under a minute, but it is a chain of two
// facts rather than one absence. ⛔ If a second import of this module ever
// appears, that chain is broken and the claim must be rewritten rather than
// repeated.
//
// ⛔ IT REPORTS TO THE WORKER, NOT TO THE NOTIFICATION BEACON. Sending to
// thonly.org/api/track would mean shipping every user of this package a working
// recipe for writing into the founder's admin notification channel, behind an
// Origin header a CLI can trivially assert. The worker's /gap endpoint writes to
// Analytics Engine and pushes nothing at anyone.

const ENDPOINT = "https://corpus.333.eco/report";

// ⚠️ A BUG REPORT AND A GAP REPORT CARRY THE SAME PAYLOAD, DELIBERATELY. It is
// tempting to attach a node version and a platform to a bug — genuinely useful
// to whoever fixes it — but that would give this command two different promises
// about what it sends, and the promise is the valuable part. Anything about your
// environment that matters, put in the text; then you have said it on purpose.
const KINDS = {
    gap: {
        prompt: "what you looked for and did not find",
        thanks: "Thank you — recorded. It joins the gaps the hosted endpoint already sees."
    },
    bug: {
        prompt: "what went wrong, and what you expected instead",
        thanks: "Thank you — recorded. Issues are also welcome at github.com/333eco/corpus.333.eco/issues."
    }
};
const MAX = 200;

// ⭐ WHAT IS SENT IS THE WHOLE OF WHAT IS SENT. The text you typed, and the
// version of the corpus you have. No machine id, no username, no hostname, no
// path, no timestamp of your own — and the receiving end deliberately does not
// record the country it could resolve, because a voluntary note about a missing
// document has no use for where the sender was standing.
export const report = async (kind, text, version) => {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`unknown report kind: ${kind}`);
    const body = String(text ?? "").trim().slice(0, MAX);
    if (!body) {
        console.error(`usage: corpus-mcp --report-${kind} "${spec.prompt}"`);
        return 1;
    }

    const payload = { kind, text: body, version: version ?? null };

    // Printed BEFORE the request, not after, so the disclosure is not
    // contingent on the request succeeding.
    console.log("Sending this, and nothing else:\n");
    console.log("  " + JSON.stringify(payload));
    console.log("\n  to " + ENDPOINT + "\n");

    try {
        const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        });
        // ⚠️⚠️ THE STATUS CODE IS NOT THE CONTRACT, AND TRUSTING IT REPORTED A
        // FALSE SUCCESS ON THE FIRST RUN. A server predating /gap treats any
        // POST without a JSON-RPC `id` as a NOTIFICATION and answers 202 with an
        // empty body — so `res.ok` was true, and this printed "recorded" while
        // nothing had been. The success signal must therefore be something only
        // the real handler can produce: an explicit `ok` in the body. That also
        // makes version skew safe in both directions, since an old server can
        // never accidentally satisfy it.
        const ack = await res.json().catch(() => null);
        if (res.ok && ack?.ok === true) {
            console.log(spec.thanks);
            return 0;
        }
        console.error(
            res.ok
                ? "The endpoint accepted the request but did not confirm it recorded anything —\n" +
                  "it is probably running a version without /report. Nothing was recorded."
                : `The endpoint answered ${res.status}. Nothing was recorded.`
        );
        return 1;
    } catch (e) {
        // A failure here is worth nobody's day. Say so and exit cleanly.
        console.error(`Could not reach ${ENDPOINT}: ${e.message}`);
        console.error("Nothing was sent. This is entirely optional — carry on.");
        return 1;
    }
};
