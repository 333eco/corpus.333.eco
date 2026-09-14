#!/usr/bin/env node
// Do the 2.4.1 reading nudges make a model READ more of the corpus? — a controlled two-arm test on 2.4.2.
//
//   node experiments/read-ab/ab.mjs --out <dir>              the pre-registered runs, in order
//   node experiments/read-ab/ab.mjs --out <dir> --smoke [--arm A] [--prompt P] [--local DIR]   a cheap probe
//
// ARMS, both built from the PUBLISHED @333eco/corpus@2.4.2 so anyone can reproduce them:
//   nudge — the package as published;
//   plain — the same tarball with the three nudges removed (the server-instructions sentence, the
//           search result's reading line in text and structure, list_documents' read_with).
// ⚠️ 2.3.5 and 2.4.0 are NOT arms: through a Claude client they deliver zero documents
// (§the-text-never-arrived), which the probes of 2026-09-13 already established.
//
// ⭐ WHY A TEST AND NOT A WATCH. Real model traffic to corpus.333.eco was ~28 tool calls in ten
// days (2026-09-04 → 09-14), so a before/after share would sit inside the noise for months.
// The same question asked of the same model against both server versions answers it in an hour.
//
// ⭐ ISOLATION, because a session that already knows HeartBank measures nothing:
//   · each run starts in a fresh EMPTY directory — no CLAUDE.md to discover, no project memory;
//   · --setting-sources project (there is no project), --strict-mcp-config with ONE server;
//   · the only built-in tool is Read, so a result Claude Code moves to a file stays readable —
//     without it, 2.3.5's largest documents (no size annotation) would be unreadable for a reason
//     unrelated to the thing being tested;
//   · the servers are the PUBLISHED packages via npx, stdio — the npm package records nothing,
//     so the test adds no rows to the live server's analytics.
//
// ⛔ WHAT IS KEPT: compact per-run metrics and the final answer. NOT the transcript — it carries
// whole documents, and the corpus is already public at a pinned version.
//
// ⚠️ The protocol, predictions and analysis rule are pre-registered in memory
// (project_corpus_mcp_server §read-ab-prereg) and pushed BEFORE the first real run.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const OUT = args[args.indexOf("--out") + 1];
if (!args.includes("--out") || !OUT) {
    console.error("usage: ab.mjs --out <dir> [--smoke]");
    process.exit(2);
}
const SMOKE = args.includes("--smoke");

const MODEL = "claude-opus-5";
const EFFORT = "xhigh";
const VERSION = "2.4.2";
const ARMS = { plain: "2.4.2 without nudges", nudge: "2.4.2" };
const QUESTIONS = {
    Q1: "Using the connected corpus, what is HeartBank and how is it structured?",
    Q2: "Using the connected corpus, who is Thon Ly and what is he building?",
    Q3: "Using the connected corpus, what is the Zero-Point Game?"
};
const BUDGET_USD = SMOKE ? 0.5 : 5;

// Interleaved, and the arm order reverses between replicates so no arm always runs first or last.
const PLAN = SMOKE
    ? [{ arm: args.includes("--arm") ? args[args.indexOf("--arm") + 1] : "nudge", q: "SMOKE", rep: 0 }]
    : [1, 2].flatMap((rep) =>
          Object.keys(QUESTIONS).flatMap((q) =>
              (rep === 1 ? ["plain", "nudge"] : ["nudge", "plain"]).map((arm) => ({ arm, q, rep }))
          )
      );
const SMOKE_PROMPT = args.includes("--prompt")
    ? args[args.indexOf("--prompt") + 1]
    : "Using the connected corpus, list its document categories and how many documents each holds.";


// ── the plain arm: the published tarball, nudges removed ─────────────────────
// ⛔ Every removal is ASSERTED: if 2.4.2's text ever differs from what is patched here, the
// build refuses rather than silently running "plain" with a nudge still in it.
const preparePlain = () => {
    const root = mkdtempSync(join(tmpdir(), "read-ab-plain-"));
    execFileSync("npm", ["pack", `@333eco/corpus@${VERSION}`, "--silent"], { cwd: root });
    execFileSync("tar", ["-xzf", `333eco-corpus-${VERSION}.tgz`], { cwd: root });
    const pkg = join(root, "package");
    const patch = (rel, from, to) => {
        const f = join(pkg, rel);
        const t = readFileSync(f, "utf8");
        if (!t.includes(from)) throw new Error(`plain arm: ${rel} no longer contains the nudge to remove: ${from.slice(0, 60)}`);
        writeFileSync(f, t.replace(from, to));
    };
    patch("src/read-tools.mjs", "export const READ_INSTRUCTIONS =\n", "export const READ_INSTRUCTIONS = \"\" && \n");
    patch("src/search.mjs", '"\\n\\n" + readingLine(results, hits.length)', '""');
    patch("src/search.mjs", "...(results.length ? { reading: readingLine(results, hits.length) } : {}),", "");
    patch("src/server.mjs", "...(readWith(args, list.length) ? { read_with: readWith(args, list.length) } : {}),", "");
    return pkg;
};
const PLAIN = SMOKE && !args.includes("--arm") ? null : preparePlain();
if (PLAIN) process.stderr.write(`plain arm built at ${PLAIN}\n`);

mkdirSync(OUT, { recursive: true });

const runOne = ({ arm, q, rep }) =>
    new Promise((resolve) => {
        const dir = mkdtempSync(join(tmpdir(), "read-ab-"));
        const cfg = join(dir, "..", `read-ab-mcp-${arm}-${process.pid}.json`);
        // --local <dir> probes an UNPUBLISHED build (node <dir>/src/server.mjs) instead of a published package.
        const local = args.includes("--local") ? args[args.indexOf("--local") + 1] : null;
        const server = local
            ? { command: "node", args: [join(local, "src", "server.mjs")] }
            : arm === "plain"
              ? { command: "node", args: [join(PLAIN, "src", "server.mjs")] }
              : { command: "npx", args: ["-y", `@333eco/corpus@${VERSION}`] };
        writeFileSync(cfg, JSON.stringify({ mcpServers: { corpus: server } }));
        const prompt = q === "SMOKE" ? SMOKE_PROMPT : QUESTIONS[q];
        const child = spawn(
            "claude",
            [
                "-p", prompt,
                "--model", MODEL,
                "--settings", JSON.stringify({ effortLevel: EFFORT }),
                "--setting-sources", "project",
                "--strict-mcp-config", "--mcp-config", cfg,
                "--tools", "Read",
                "--allowedTools", "mcp__corpus", "Read",
                "--no-session-persistence",
                "--output-format", "stream-json", "--verbose",
                "--max-budget-usd", String(BUDGET_USD)
            ],
            { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }
        );
        let buf = "";
        const events = [];
        child.stdout.on("data", (b) => {
            buf += b;
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (line.trim()) try { events.push(JSON.parse(line)); } catch { /* a non-JSON line is not an event */ }
            }
        });
        let stderr = "";
        child.stderr.on("data", (b) => (stderr += b));
        child.on("exit", (code) => resolve({ arm, q, rep, code, events, stderr: stderr.slice(-2000) }));
    });

// ── metrics ───────────────────────────────────────────────────────────────────
const END = /\[END OF DOCUMENT — ([^\s·.\]]+)/g;
const HEADER_SLUG = /^slug:\s+(\S+)/gm;
const textOf = (content) =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c.type === "text" ? c.text : "")).join("\n") : "";

const metrics = (run) => {
    const init = run.events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
    const result = run.events.find((e) => e.type === "result") ?? {};
    const calls = [];
    const byId = new Map();
    for (const e of run.events) {
        if (e.type === "assistant") {
            for (const c of e.message?.content ?? []) {
                if (c.type === "tool_use") {
                    const call = { tool: c.name.replace(/^mcp__corpus__/, ""), input: c.input, result_bytes: 0, is_error: false, has_header: false, end_slugs: [], header_slugs: [] };
                    calls.push(call);
                    byId.set(c.id, call);
                }
            }
        }
        if (e.type === "user") {
            for (const c of e.message?.content ?? []) {
                if (c.type === "tool_result" && byId.has(c.tool_use_id)) {
                    const call = byId.get(c.tool_use_id);
                    const t = textOf(c.content);
                    call.result_bytes = Buffer.byteLength(t, "utf8");
                    call.is_error = Boolean(c.is_error);
                    call.has_header = t.includes("[PROVENANCE");
                    call.end_slugs = [...t.matchAll(END)].map((m) => m[1]);
                    call.header_slugs = [...t.matchAll(HEADER_SLUG)].map((m) => m[1]);
                }
            }
        }
    }
    const count = (name) => calls.filter((c) => c.tool === name).length;
    // ⭐ A document counts as READ IN FULL only by what REACHED THE SESSION, never by what was asked for:
    //   · get_document whose result carries the provenance header (2.3.5 has no end line; an inline
    //     result is the whole document);
    //   · a read_documents page's [END OF DOCUMENT] lines;
    //   · a Read of a result Claude Code moved to a file, when that Read returns the header — counted
    //     SEPARATELY as via_file, because Read can return part of a long file.
    // ⚠️ A document result with no header and no error is "offloaded, not read back" — counted, not guessed.
    const full = new Set();
    const viaFile = new Set();
    for (const c of calls) {
        if (c.tool === "get_document" && c.input?.slug && c.has_header) full.add(c.input.slug);
        if (c.tool === "read_documents") c.end_slugs.forEach((x) => full.add(x));
        if (c.tool === "Read") [...c.end_slugs, ...c.header_slugs].forEach((x) => viaFile.add(x));
    }
    for (const x of full) viaFile.delete(x);
    return {
        arm: run.arm,
        server: ARMS[run.arm],
        question: run.q,
        rep: run.rep,
        exit_code: run.code,
        isolation: {
            model: init.model ?? null,
            mcp_servers: (init.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`),
            tools: init.tools ?? null,
            cwd_is_empty_tmp: typeof init.cwd === "string" && init.cwd.includes("read-ab-")
        },
        tool_calls: calls.length,
        by_tool: Object.fromEntries(["search_corpus", "list_documents", "get_document", "read_documents", "get_program", "get_prediction", "list_predictions", "Read"].map((t) => [t, count(t)]).filter(([, n]) => n)),
        documents_read_in_full: full.size,
        documents: [...full].sort(),
        documents_via_file: [...viaFile].sort(),
        document_bytes: calls.filter((c) => c.tool === "get_document" || c.tool === "read_documents").reduce((n, c) => n + c.result_bytes, 0),
        offloaded_not_inline: calls.filter((c) => (c.tool === "get_document" || c.tool === "read_documents") && !c.has_header && !c.is_error).length,
        turns: result.num_turns ?? null,
        cost_usd: result.total_cost_usd ?? null,
        hit_budget: /budget/i.test(result.subtype ?? "") || /budget/i.test(run.stderr),
        result_subtype: result.subtype ?? null,
        answer_words: String(result.result ?? "").split(/\s+/).filter(Boolean).length,
        answer: result.result ?? null,
        stderr_tail: run.code ? run.stderr : undefined
    };
};

const started = new Date().toISOString();
const rows = [];
for (const [i, step] of PLAN.entries()) {
    process.stderr.write(`[${i + 1}/${PLAN.length}] ${step.q} · ${step.arm} (${ARMS[step.arm]}) · rep ${step.rep} … `);
    const m = metrics(await runOne(step));
    rows.push(m);
    writeFileSync(join(OUT, `${SMOKE ? "smoke" : `${step.q}-${step.arm}-r${step.rep}`}.json`), JSON.stringify(m, null, 2) + "\n");
    process.stderr.write(`${m.tool_calls} calls · ${m.documents_read_in_full} docs in full · ${m.documents_via_file.length} via file · $${m.cost_usd?.toFixed?.(2) ?? "?"}${m.hit_budget ? " · BUDGET HIT" : ""}\n`);
}
writeFileSync(
    join(OUT, SMOKE ? "smoke-summary.json" : "summary.json"),
    JSON.stringify({ started, finished: new Date().toISOString(), model: MODEL, effort: EFFORT, arms: ARMS, budget_usd: BUDGET_USD, runs: rows.map(({ answer, ...r }) => r) }, null, 2) + "\n"
);
