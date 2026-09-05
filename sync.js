#!/usr/bin/env node

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import readline from "node:readline";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- config ---

function envStr(name, def) {
  const v = process.env[name];
  return v == null || v.trim() === "" ? def : v.trim();
}

function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null || v.trim() === "") return def;
  return /^(1|true|yes|y|on)$/i.test(v.trim());
}

function envInt(name, def) {
  const n = Number.parseInt(envStr(name, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const CONFIG = {
  org: envStr("SYNC_ORG", "tbxark-fork"),
  // Branches matching this pattern are never created in the fork, and are
  // deleted without asking once they disappear upstream. Upstream repos that
  // auto-generate branches (backups/*, dependabot/*, ...) would otherwise grow
  // the work list without bound on every run.
  skipPattern: new RegExp(
    envStr(
      "SYNC_BRANCH_FILTER",
      "^dependabot/|^renovate/|^copilot/|^coderabbitai/|^backups?/|sparkle",
    ),
  ),
  // Without this, the filter only blocks *creation*: a matching branch that is
  // already in the fork gets synced against upstream forever. Purging deletes
  // it from the fork even while upstream still has it.
  purgeFiltered: envBool("SYNC_PURGE_FILTERED", true),
  maxBranches: envInt("SYNC_MAX_BRANCHES", 100),
  concurrency: envInt("SYNC_CONCURRENCY", 4),
  repoLimit: envInt("SYNC_REPO_LIMIT", 1000),
  timeoutMs: envInt("SYNC_TIMEOUT_MS", 120_000),
  reportFile: envStr("SYNC_REPORT_FILE", "SYNC.md"),
  createMissing: envBool("SYNC_CREATE_MISSING", true),
  deleteRemoved: envBool("SYNC_DELETE_REMOVED", false),
  force: envBool("SYNC_FORCE", false),
  dryRun: envBool("SYNC_DRY_RUN", false),
  nonInteractive: envBool("SYNC_NON_INTERACTIVE", false),
};

const INTERACTIVE = !CONFIG.nonInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY);

// ------------------------------------------------------------------ utils ---

function log(msg = "") {
  console.log(msg);
}

function warn(msg) {
  console.warn(msg);
}

/**
 * Runs `gh` with an argv array (never a shell string), so branch names with
 * slashes, spaces or shell metacharacters can't break or inject anything.
 */
async function gh(args) {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: CONFIG.timeoutMs,
    });
    return { ok: true, stdout: stdout.trim(), error: "" };
  } catch (err) {
    // err.message re-echoes the whole command plus stderr, which crowds out the
    // actual reason once it's truncated for the report. Prefer gh's own output.
    const parts = [err.stderr, err.stdout]
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
    const error = parts.length ? parts.join(" | ") : String(err.message ?? "").trim();
    return { ok: false, stdout: "", error };
  }
}

/** Same as gh(), but a no-op under SYNC_DRY_RUN. */
async function ghWrite(args) {
  if (CONFIG.dryRun) {
    log(`       (dry-run) gh ${args.join(" ")}`);
    return { ok: true, stdout: "", error: "" };
  }
  return gh(args);
}

async function ask(question, autoAnswer) {
  if (!INTERACTIVE) {
    log(`${question}${autoAnswer} (auto)`);
    return autoAnswer;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return answer.trim() || autoAnswer;
  } finally {
    rl.close();
  }
}

const isYes = (answer) => /^y(es)?$/i.test(answer);

/** Runs `fn` over `items` with at most `limit` operations in flight. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Caps a work list, recording exactly what was dropped instead of truncating silently. */
function cap(items, label, stats) {
  if (items.length <= CONFIG.maxBranches) return items;
  const deferred = items.slice(CONFIG.maxBranches);
  stats.deferred.push(...deferred.map((b) => `${label}:${b}`));
  warn(`  !! ${label}: ${items.length} branches exceeds SYNC_MAX_BRANCHES=${CONFIG.maxBranches}, deferring ${deferred.length} to a later run`);
  return items.slice(0, CONFIG.maxBranches);
}

// ----------------------------------------------------------------- github ---

/** @returns {Promise<Map<string, string>>} branch name -> head commit sha */
async function listBranches(repo) {
  const res = await gh([
    "api",
    `repos/${repo}/branches`,
    "--paginate",
    "--jq",
    '.[] | .name + "\\t" + .commit.sha',
  ]);
  if (!res.ok) throw new Error(`failed to list branches of ${repo}: ${res.error}`);
  const branches = new Map();
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const [name, sha] = line.split("\t");
    if (name) branches.set(name, sha);
  }
  return branches;
}

async function listForks() {
  const res = await gh([
    "repo",
    "list",
    CONFIG.org,
    "--fork",
    "--visibility",
    "public",
    "--limit",
    String(CONFIG.repoLimit),
    "--json",
    "owner,name,parent,defaultBranchRef",
  ]);
  if (!res.ok) throw new Error(`failed to list forks of ${CONFIG.org}: ${res.error}`);
  return JSON.parse(res.stdout);
}

// ------------------------------------------------------------------- sync ---

async function syncExisting(forkRepo, upstreamRepo, branches, stats) {
  if (branches.length === 0) return;
  log(`  -> syncing ${branches.length} out-of-date branch(es)`);

  const failures = [];
  await mapPool(branches, CONFIG.concurrency, async (branch) => {
    const args = ["repo", "sync", forkRepo, "--source", upstreamRepo, "--branch", branch];
    if (CONFIG.force) args.push("--force");
    const res = await ghWrite(args);
    if (res.ok) {
      log(`     ok  ${branch}`);
      stats.synced.push(branch);
    } else {
      warn(`     !!  ${branch}: ${res.error}`);
      failures.push({ branch, error: res.error });
    }
  });

  // Prompts run after the parallel pass so concurrent output can't interleave
  // with the readline prompt.
  for (const { branch, error } of failures) {
    if (CONFIG.force) {
      stats.failed.push({ branch, action: "sync", error });
      continue;
    }
    if (/Branch not found|HTTP 404/i.test(error)) {
      // --force can't fix a missing ref; retrying would just burn API calls.
      warn(`     -> '${branch}' missing on one side, --force would not help; skipped`);
      stats.failed.push({ branch, action: "sync", error });
      continue;
    }
    const answer = await ask(`     ? Force sync branch '${branch}' (y/N): `, "N");
    if (!isYes(answer)) {
      stats.failed.push({ branch, action: "sync", error });
      continue;
    }
    const res = await ghWrite([
      "repo", "sync", forkRepo, "--source", upstreamRepo, "--branch", branch, "--force",
    ]);
    if (res.ok) {
      log(`     -> force synced ${branch}`);
      stats.synced.push(branch);
    } else {
      warn(`     !! force sync also failed for ${branch}: ${res.error}`);
      stats.failed.push({ branch, action: "force-sync", error: res.error });
    }
  }
}

async function createBranches(forkRepo, branches, upstream, stats) {
  if (branches.length === 0) return;
  log(`  -> creating ${branches.length} new branch(es)`);
  await mapPool(branches, CONFIG.concurrency, async (branch) => {
    const res = await ghWrite([
      "api", "-X", "POST", `repos/${forkRepo}/git/refs`,
      "-f", `ref=refs/heads/${branch}`,
      "-f", `sha=${upstream.get(branch)}`,
    ]);
    if (res.ok) {
      log(`     new ${branch}`);
      stats.created.push(branch);
    } else {
      warn(`     !!  failed to create ${branch}: ${res.error}`);
      stats.failed.push({ branch, action: "create", error: res.error });
    }
  });
}

async function deleteBranches(forkRepo, branches, stats, { reason, bucket, autoDelete }) {
  if (branches.length === 0) return;
  log(`  -> ${branches.length} branch(es) ${reason}`);
  for (const branch of branches) {
    const auto = autoDelete(branch);
    const answer = await ask(
      `     ? Delete branch '${branch}' from ${forkRepo} (${auto ? "Y/n" : "y/N"}): `,
      auto ? "y" : "N",
    );
    if (!isYes(answer)) {
      log(`     -> kept '${branch}'`);
      stats.kept.push(branch);
      continue;
    }
    const res = await ghWrite(["api", "-X", "DELETE", `repos/${forkRepo}/git/refs/heads/${branch}`]);
    if (res.ok) {
      log(`     del ${branch}`);
      stats[bucket].push(branch);
    } else {
      warn(`     !! failed to delete ${branch} (protected or permission denied): ${res.error}`);
      stats.failed.push({ branch, action: "delete", error: res.error });
    }
  }
}

async function syncRepo(forkRepo, upstreamRepo, defaultBranch) {
  log(`\n=== Sync ${forkRepo} from ${upstreamRepo} ===`);
  const stats = {
    repo: forkRepo,
    upstream: upstreamRepo,
    upToDate: 0,
    synced: [],
    created: [],
    deleted: [],
    purged: [],
    kept: [],
    filtered: [],
    deferred: [],
    failed: [],
  };

  const [upstream, fork] = await Promise.all([listBranches(upstreamRepo), listBranches(forkRepo)]);

  // Deleting the default branch would leave the fork headless, and no filter is
  // worth that — keep it no matter what the pattern says.
  const purgeable = (b) =>
    CONFIG.purgeFiltered && b !== defaultBranch && CONFIG.skipPattern.test(b);
  const toPurge = [...fork.keys()].filter(purgeable);
  const purgeSet = new Set(toPurge);

  const toSync = [];
  const toCreate = [];
  for (const [branch, sha] of upstream) {
    if (fork.has(branch)) {
      // Syncing a branch we're about to purge would just burn API calls.
      if (purgeSet.has(branch)) continue;
      // Comparing SHAs first is what keeps this cheap: unchanged branches cost
      // zero API calls instead of one merge-upstream request each.
      if (fork.get(branch) === sha) stats.upToDate++;
      else toSync.push(branch);
    } else if (CONFIG.createMissing && !CONFIG.skipPattern.test(branch)) {
      toCreate.push(branch);
    } else {
      stats.filtered.push(branch);
    }
  }
  const toDelete = [...fork.keys()].filter((b) => !upstream.has(b) && !purgeSet.has(b));

  log(
    `  -> upstream ${upstream.size} / fork ${fork.size} branches: ` +
      `${stats.upToDate} up-to-date, ${toSync.length} to sync, ${toCreate.length} to create, ` +
      `${toDelete.length} removed upstream, ${toPurge.length} to purge, ${stats.filtered.length} filtered`,
  );

  await syncExisting(forkRepo, upstreamRepo, cap(toSync, "sync", stats), stats);
  await createBranches(forkRepo, cap(toCreate, "create", stats), upstream, stats);
  await deleteBranches(forkRepo, toDelete, stats, {
    reason: "exist in fork but not upstream",
    bucket: "deleted",
    autoDelete: (b) => CONFIG.deleteRemoved || CONFIG.skipPattern.test(b),
  });
  await deleteBranches(forkRepo, toPurge, stats, {
    reason: `match the branch filter (purge)`,
    bucket: "purged",
    autoDelete: () => true,
  });

  return stats;
}

// ----------------------------------------------------------------- report ---

function inlineCode(items, max = 12) {
  const head = items.slice(0, max).map((b) => `\`${b}\``).join(", ");
  return items.length > max ? `${head} … +${items.length - max} more` : head;
}

/** Encodes a ref for a GitHub URL path, keeping the `/` in `feat/foo` readable. */
function refPath(branch) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * Links to what the fork branch has that upstream doesn't — i.e. exactly the
 * commits `gh repo sync --force` would throw away. The three-part
 * `owner:repo:branch` head is required because some forks were renamed and
 * `owner:branch` would resolve against the wrong repository.
 */
function compareLink(forkRepo, upstreamRepo, branch) {
  if (!branch || !upstreamRepo) return "—";
  const [upOwner, upName] = upstreamRepo.split("/");
  if (!upOwner || !upName) return "—";
  const base = `${upOwner}:${upName}:${refPath(branch)}`;
  return `[compare](https://github.com/${forkRepo}/compare/${base}...${refPath(branch)})`;
}

/** Collapses gh's multi-line stderr so it survives a markdown table/list. */
function oneLine(text, max = 200) {
  const s = String(text).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildReport({ started, finished, summary, aborted, fatal }) {
  const runUrl =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const stamp = (d) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const totals = summary.reduce(
    (acc, s) => ({
      synced: acc.synced + s.synced.length,
      created: acc.created + s.created.length,
      deleted: acc.deleted + s.deleted.length,
      purged: acc.purged + s.purged.length,
      filtered: acc.filtered + s.filtered.length,
      failed: acc.failed + s.failed.length,
    }),
    { synced: 0, created: 0, deleted: 0, purged: 0, filtered: 0, failed: 0 },
  );

  const out = [];
  out.push("# Fork Sync Report", "");
  out.push("<!-- Generated by sync.js — do not edit by hand. -->", "");
  out.push(`- **Last sync**: ${stamp(finished)} (took ${Math.round((finished - started) / 1000)}s)`);
  out.push(`- **Organization**: \`${CONFIG.org}\``);
  out.push(
    `- **Result**: ${summary.length} repo(s) processed, ${aborted.length} aborted, ` +
      `${totals.synced} branch(es) synced, ${totals.created} created, ${totals.deleted} deleted, ` +
      `${totals.purged} purged, ${totals.filtered} filtered, ${totals.failed} failed`,
  );
  out.push(`- **Branch filter**: \`${CONFIG.skipPattern.source}\``);
  if (fatal) out.push(`- **Run failed**: ${oneLine(fatal, 400)}`);
  if (CONFIG.dryRun) out.push("- **Mode**: dry run (no changes were pushed)");
  if (runUrl) out.push(`- **Workflow run**: ${runUrl}`);
  out.push("");

  // Failures go first: they're the only part of the report that needs action,
  // and they used to be buried per-repo at the bottom of ## Details.
  const failures = [
    ...aborted.map((a) => ({ repo: a.repo, upstream: a.upstream, branch: null, action: "repo aborted", error: a.error })),
    ...summary.flatMap((s) => s.failed.map((f) => ({ repo: s.repo, upstream: s.upstream, ...f }))),
  ];
  if (failures.length) {
    out.push(`## Failures (${failures.length})`, "");
    out.push("| Fork | Branch | Action | Ahead of upstream | Error |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const f of failures) {
      // A failed `create` never landed in the fork, so point at the upstream
      // ref that does exist rather than emitting a 404.
      const host = f.action === "create" ? f.upstream : f.repo;
      const branchCell =
        f.branch && host
          ? `[\`${f.branch}\`](https://github.com/${host}/tree/${refPath(f.branch)})`
          : f.branch
            ? `\`${f.branch}\``
            : "—";
      const ahead = f.action === "create" ? "—" : compareLink(f.repo, f.upstream, f.branch);
      out.push(
        `| [${f.repo}](https://github.com/${f.repo}) | ${branchCell} | ${f.action} | ` +
          `${ahead} | ${oneLine(f.error)} |`,
      );
    }
    out.push("");
  }

  out.push("## Repositories", "");
  out.push("| Fork | Upstream | Up-to-date | Synced | Created | Deleted | Purged | Filtered | Failed |");
  out.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of summary) {
    out.push(
      `| [${s.repo}](https://github.com/${s.repo}) | [${s.upstream}](https://github.com/${s.upstream}) | ` +
        `${s.upToDate} | ${s.synced.length} | ${s.created.length} | ${s.deleted.length} | ` +
        `${s.purged.length} | ${s.filtered.length} | ${s.failed.length ? `**${s.failed.length}** ⚠️` : 0} |`,
    );
  }
  for (const a of aborted) {
    out.push(
      `| [${a.repo}](https://github.com/${a.repo}) | ${a.upstream ?? "?"} | — | — | — | — | — | — | **aborted** ⚠️ |`,
    );
  }
  out.push("");

  // Failures are already covered above, so they don't gate a repo's row here.
  const ACTIONS = [
    ["Synced", (s) => s.synced],
    ["Created", (s) => s.created],
    ["Deleted", (s) => s.deleted],
    ["Purged (filter)", (s) => s.purged],
    ["Kept", (s) => s.kept],
    ["Deferred to next run", (s) => s.deferred],
  ];
  const changed = summary.filter((s) => ACTIONS.some(([, pick]) => pick(s).length));
  if (changed.length) {
    out.push("## Details", "");
    out.push("| Fork | Action | Count | Branches |");
    out.push("| --- | --- | ---: | --- |");
    for (const s of changed) {
      // Only the first row of a repo carries the link; the blank cells below it
      // read as a group instead of repeating the same URL five times.
      let label = `[${s.repo}](https://github.com/${s.repo})`;
      for (const [action, pick] of ACTIONS) {
        const branches = pick(s);
        if (!branches.length) continue;
        out.push(`| ${label} | ${action} | ${branches.length} | ${inlineCode(branches)} |`);
        label = "";
      }
    }
    out.push("");
  }

  const filtered = summary.filter((s) => s.filtered.length);
  if (filtered.length) {
    out.push("<details>", "<summary>Filtered branches (never created in the fork)</summary>", "");
    for (const s of filtered) out.push(`- **${s.repo}** (${s.filtered.length}): ${inlineCode(s.filtered, 8)}`);
    out.push("", "</details>", "");
  }

  return out.join("\n");
}

async function writeReport(data) {
  if (CONFIG.dryRun && !process.env.SYNC_REPORT_FILE) {
    // Don't clobber the committed report during a local dry run.
    log(`\n(dry-run) skipped writing ${CONFIG.reportFile}`);
    return;
  }
  try {
    await writeFile(CONFIG.reportFile, buildReport(data), "utf8");
    log(`\n-> report written to ${CONFIG.reportFile}`);
  } catch (err) {
    warn(`!! failed to write ${CONFIG.reportFile}: ${err.message}`);
  }
}

// ------------------------------------------------------------------- main ---

async function main() {
  const started = new Date();
  log(
    `Syncing forks of '${CONFIG.org}' ` +
      `[${INTERACTIVE ? "interactive" : "non-interactive"}${CONFIG.dryRun ? ", dry-run" : ""}` +
      `${CONFIG.force ? ", force" : ""}, filter=${CONFIG.skipPattern.source}]`,
  );

  const summary = [];
  const aborted = [];
  let fatal = null;

  try {
    for (const repo of await listForks()) {
      const forkRepo = `${repo.owner.login}/${repo.name}`;
      if (!repo.parent) {
        warn(`\n=== Skip ${forkRepo}: no parent repository ===`);
        aborted.push({ repo: forkRepo, upstream: null, error: "no parent repository" });
        continue;
      }
      const upstreamRepo = `${repo.parent.owner.login}/${repo.parent.name}`;
      try {
        // One broken repo must not abort the whole run.
        summary.push(await syncRepo(forkRepo, upstreamRepo, repo.defaultBranchRef?.name));
      } catch (err) {
        warn(`  !! ${forkRepo} aborted: ${err.message}`);
        aborted.push({ repo: forkRepo, upstream: upstreamRepo, error: err.message });
      }
    }
  } catch (err) {
    // e.g. gh isn't authenticated — record it in the report instead of leaving
    // yesterday's numbers behind.
    fatal = err.message;
  } finally {
    // Always leave a report behind, even if the run dies part-way through.
    await writeReport({ started, finished: new Date(), summary, aborted, fatal });
  }

  if (fatal) throw new Error(fatal);

  log("\n=== Summary ===");
  for (const s of summary) {
    const parts = [
      s.synced.length && `${s.synced.length} synced`,
      s.created.length && `${s.created.length} created`,
      s.deleted.length && `${s.deleted.length} deleted`,
      s.purged.length && `${s.purged.length} purged`,
      s.filtered.length && `${s.filtered.length} filtered`,
      s.failed.length && `${s.failed.length} failed`,
    ].filter(Boolean);
    log(`  ${s.repo}: ${parts.length ? parts.join(", ") : "up to date"}`);
  }
  const failedOps = summary.reduce((n, s) => n + s.failed.length, 0);
  log(`  ${summary.length} repo(s) processed, ${aborted.length} aborted, ${failedOps} failed operation(s)`);
  if (aborted.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
