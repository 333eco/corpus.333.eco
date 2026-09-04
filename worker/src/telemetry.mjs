// What the remote surface records, and what it interrupts someone about.
//
// Two channels, and the split is the whole design:
//
//     Analytics Engine  — counts everything, stays here, answers "is this used"
//     /api/track beacon — the few things worth a phone buzzing, and nothing else
//
// ⛔ THE STDIO SERVER GETS NONE OF THIS, and the asymmetry is the point rather
// than an oversight. This worker runs on our own infrastructure and already sees
// every request it answers; writing down what it was asked adds no reach it did
// not already have. `npx @333eco/corpus` runs on a STRANGER'S MACHINE, where the
// same few lines would be an outbound report about someone's private reading.
// A package that phones home is a different artifact from one that does not.
// ⚠️ If telemetry is ever wanted on the local surface, that is a decision about
// what the package IS, and it belongs in the README before it belongs in code.
//
// ⭐ NO PER-CALLER IDENTITY IS COMPUTED ANYWHERE IN THIS FILE. The client label
// is the SOFTWARE's name — "claude-code", "cursor" — taken from the handshake it
// volunteers, never an IP, never a hash of one, never a cookie. Every user of a
// given client is one label. That is not a promise to behave well: there is no
// code path here that derives a per-caller id, so there is nothing to leak, sell,
// subpoena or regret. The question this server wants answered is *which clients
// reach it*, and that question needs no persons in it.

// The corpus's own hostname, which the allowlist in thonly.org's track-http.ts
// already admits (`([a-z0-9-]+\.)*333\.eco`) — verified against the live endpoint
// rather than read off the regex.
//
// ⚠️ IT MUST BE SET EXPLICITLY AND THE BEACON IS DEAD WITHOUT IT. A browser sets
// Origin; a server-side fetch does not, and the gate 403s a request that carries
// none — confirmed live, not assumed. This constant is that header.
const TRACK_ENDPOINT = "https://thonly.org/api/track";
const TRACK_ORIGIN = "https://corpus.333.eco";

// Client names are advertised by the client and therefore arbitrary. Normalise
// hard: this string becomes an Analytics Engine index (96-byte cap) and a
// Firestore document id, and neither should inherit a stranger's punctuation.
const label = (s) =>
    String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "unknown";

// ⚠️ THE HANDSHAKE IS THE ONLY REQUEST THAT NAMES THE CLIENT. This transport is
// stateless — no session id, no connection — so `tools/call` arrives with nothing
// but a User-Agent. That is a real limit, not a bug to fix: the alternative is
// issuing callers an identifier, which is exactly what the note above says this
// file will not do. Calls are attributed to their user-agent and grouped loosely.
export const clientOf = (msg, request) => {
    const info = msg?.method === "initialize" ? msg?.params?.clientInfo : null;
    if (info?.name) return label(info.name);
    const ua = request.headers.get("user-agent") ?? "";
    // Node's default UA is "node" or "undici"; keep the token, drop the version.
    return label(ua.split(/[/\s]/)[0]);
};

/* ------------------------------------------------------------ analytics ------
   One data point per JSON-RPC call. Free, local to the datacenter, and written
   inside waitUntil so it is never in front of a response. */

export const record = (env, ctx, fields) => {
    if (!env.ANALYTICS) return; // unbound in `wrangler dev` without --remote
    const {
        client = "unknown",
        method = "",
        tool = "",
        slug = "",
        country = "",
        protocol = "",
        version = "",
        missedQuery = "",
        results = 0,
        errored = 0,
        ms = 0
    } = fields;
    try {
        env.ANALYTICS.writeDataPoint({
            // Sampling key. Client software is low-cardinality by construction,
            // which is what an index wants — and it is the question being asked.
            indexes: [client],
            blobs: [client, method, tool, slug, country, protocol, version, missedQuery],
            doubles: [results, errored, ms]
        });
    } catch {
        // Telemetry may never be the reason a corpus lookup fails.
    }
};

// ⭐⭐ THE ONLY QUERY TEXT THAT IS EVER STORED IS A QUERY THAT FOUND NOTHING, and
// this is a property rather than a policy. The reason to log searches at all is
// to learn what the corpus is missing; a search that SUCCEEDED tells us only what
// a caller was reading, which is their business and not ours. So the successful
// query has no storage path in this file — not a redaction step someone has to
// remember to keep, but an absent branch. Remove the enforcer and nothing breaks,
// because there is no enforcer.
export const missOf = (name, result) => {
    if (name !== "search_corpus") return "";
    const sc = result?.structuredContent;
    return sc && sc.matches === 0 ? String(sc.query ?? "").slice(0, 120) : "";
};

/* -------------------------------------------------------------- the beacon ---
   ⛔ NOT ONE POST PER TOOL CALL. An agent working through the corpus fires dozens
   of calls in seconds, and a notification channel that reports each of them is a
   channel nobody can read. Only two events leave this worker:

     corpus_connect — an MCP handshake. thonly.org's onEventCreated pushes for the
                      FIRST sighting of a client label and silently counts the
                      rest, so the interruption means "something new appeared".
     corpus_error   — the corpus asset failed to load. Rare by construction, and
                      the one thing here worth an interrupt every time.

   Counting lives in Analytics Engine, above. This channel is for surprises. */

const post = async (env, body) => {
    try {
        const res = await fetch(TRACK_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", origin: TRACK_ORIGIN },
            body: JSON.stringify(body)
        });
        return res.status;
    } catch {
        return 0;
    }
};

// ⚠️ A DEAD BEACON MUST NOT LOOK LIKE A QUIET ONE. If the allowlist changes, or
// the Workers runtime refuses to send the Origin header this depends on, the
// POST 403s and every push simply stops — which is indistinguishable from "no new
// clients this week", the exact reading that would let it stay broken for months.
// So the delivery status is written to Analytics Engine as its own row: silence
// on the phone is then something you can go and check rather than infer.
export const beacon = (env, ctx, { event, client, country, data }) => {
    ctx.waitUntil(
        post(env, {
            event,
            deviceId: client,
            location: country || "unknown",
            data: { client, ...data }
        }).then((status) => {
            record(env, ctx, {
                client,
                method: "beacon",
                tool: event,
                slug: String(status),
                country,
                errored: status === 204 ? 0 : 1
            });
        })
    );
};

// How many things a call returned, from whichever field the tool uses to say so.
// Zero is a real answer here — a search that matched nothing and a listing that
// filtered to nothing are the rows worth looking at.
export const resultsOf = (result) => {
    const sc = result?.structuredContent;
    if (!sc) return 0;
    if (typeof sc.matches === "number") return sc.matches;
    if (typeof sc.count === "number") return sc.count;
    if (Array.isArray(sc.resources)) return sc.resources.length;
    return 0;
};
