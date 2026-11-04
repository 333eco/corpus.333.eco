#!/usr/bin/env node
//
// A539's test: a build reads commits, so nothing on disk can reach the index,
// and a real change upstream must still be seen. Every mutation happens in a
// throwaway clone; the real corpus repos are read and never touched, and the
// builder only ever runs --check, so dist/ is not written.
//
//   npm run check:dirty
//
// Local only, because it needs the three source repos beside this one, and it
// assumes the committed index is current (the baseline case says so if not).

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(BASE, "scripts", "build-index.mjs");
const TH = resolve(BASE, "../../../TH/publications");
const OTHERS = [resolve(BASE, "../../../H3/publications"), resolve(BASE, "../../../missaquarius.org/missaquarius.org")];

const TMP = mkdtempSync(join(tmpdir(), "corpus-dirty-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, ...cmd) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...cmd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
    }).trim();

// A paper the index really serves, so a change to it would really change the index.
const index = JSON.parse(readFileSync(join(BASE, "dist", "corpus.json"), "utf8"));
const doc = index.documents.find((d) => d.repo === "TH/publications" && d.genre === "essays");
if (!doc) throw new Error("no served TH essay to test with: the fixture lookup is wrong");
const TARGET = doc.path;

const bare = join(TMP, "upstream.git");
execFileSync("git", ["clone", "--quiet", "--bare", TH, bare]);

let n = 0;
function clone() {
    const dir = join(TMP, `case-${++n}`, "TH", "publications");
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, dir]);
    return dir;
}
const check = (source) =>
    spawnSync(process.execPath, [BUILDER, "--check", "--from", source, ...OTHERS], { encoding: "utf8" });
const dirty = (dir, file = TARGET) => appendFileSync(join(dir, file), "\nUNCOMMITTED TEST TEXT\n");

// [name, set the clone up, should the check pass, a string the output must carry]
const CASES = [
    ["baseline: a clean clone agrees with the committed index", () => clone(), true, "dist/corpus.json is current"],
    ["a modified file stays out, and is named", () => { const d = clone(); dirty(d); return d; }, true, `not committed: ${TARGET}`],
    ["a new untracked paper stays out, and is named", () => {
        const d = clone();
        writeFileSync(join(d, "essays", "not-yet.md"), '---\ntitle: "x"\nlicense: CC0-1.0\n---\nbody\n');
        return d;
    }, true, "essays/not-yet.md"],
    ["a deleted file stays in, and is named", () => { const d = clone(); rmSync(join(d, TARGET)); return d; }, true, `not committed: ${TARGET}`],
    ["a local commit nobody pushed stays out, and is named", () => {
        const d = clone();
        dirty(d);
        git(d, "commit", "-qam", "unpushed");
        return d;
    }, true, `committed but not on origin/main: ${TARGET}`],
    ["a stale tracking ref is fetched, so a checkout behind reads what CI reads", () => {
        const d = clone();
        git(d, "reset", "--quiet", "--hard", "HEAD~1");
        git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
        return d;
    }, true, "dist/corpus.json is current"],
    ["a detached checkout reads HEAD", () => {
        const d = clone();
        git(d, "checkout", "--quiet", "--detach");
        dirty(d);
        return d;
    }, true, "(HEAD)"],
    ["an unreachable remote warns and uses the last fetch", () => {
        const d = clone();
        git(d, "remote", "set-url", "origin", join(TMP, "gone.git"));
        return d;
    }, true, "could not fetch"],
    // ⛔ THE CASE THAT MUST FAIL. Without it every case above would pass on a builder
    // that had simply stopped looking.
    ["a real change upstream IS seen: the check goes stale", () => {
        const d = clone();
        dirty(d);
        git(d, "commit", "-qam", "pushed");
        git(d, "push", "--quiet", "origin", "HEAD:main");
        const fresh = clone();
        git(d, "push", "--quiet", "--force", "origin", "HEAD~1:main");
        // `fresh` has the change on its tracking ref, but a fetch would undo it, so cut the remote.
        git(fresh, "remote", "set-url", "origin", join(TMP, "gone.git"));
        return fresh;
    }, false, "is not what the corpora currently produce"],
    ["a directory git cannot vouch for is refused", () => {
        const d = join(TMP, "plain", "TH", "publications");
        mkdirSync(d, { recursive: true });
        return d;
    }, false, "is not a git repository"],
    ["a subdirectory of a repo is refused", () => join(clone(), "essays"), false, "Name the repository root"]
];

let failed = 0;
for (const [name, setup, wantPass, wantText] of CASES) {
    const r = check(setup());
    const out = r.stdout + r.stderr;
    const ok = (r.status === 0) === wantPass && out.includes(wantText);
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "⛔"} ${name}`);
    if (!ok) console.log(`    exit ${r.status}, wanted ${wantPass ? "0" : "non-zero"} and "${wantText}"\n${out.split("\n").slice(0, 12).map((l) => "    " + l).join("\n")}`);
}
console.log(failed ? `\n⛔ ${failed} case(s) failed` : `\ncheck-dirty-source: all ${CASES.length} cases hold, tested on ${TARGET}`);
process.exit(failed ? 1 : 0);
