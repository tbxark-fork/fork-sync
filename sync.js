#!/usr/bin/env node

import { execSync } from "child_process";
import readline from "readline";

function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|y)$/i.test(String(v).trim());
}

const ORG = process.env.SYNC_ORG || "tbxark-fork";
const NON_INTERACTIVE = envBool("SYNC_NON_INTERACTIVE", false);
const DELETE_REMOVED = envBool("SYNC_DELETE_REMOVED", false);
const SYNC_FORCE = envBool("SYNC_FORCE", true);

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function ask(question) {
  if (NON_INTERACTIVE) {
    console.log(`${question}${DELETE_REMOVED ? "y (auto)" : "N (auto)"}`);
    return DELETE_REMOVED ? "y" : "N";
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getBranches(repo) {
  const out = sh(`gh api repos/${repo}/branches --paginate --jq '.[].name'`);
  return out.split("\n").filter(Boolean).sort();
}

async function syncRepo(forkRepo, upstreamRepo) {
  console.log(`\n=== Sync ${forkRepo} from ${upstreamRepo} ===`);

  const upstreamBranches = getBranches(upstreamRepo);
  for (const branch of upstreamBranches) {
    console.log(`  -> syncing branch: ${branch}`);
    try {
      sh(`gh repo sync ${forkRepo} --source ${upstreamRepo} --branch ${branch} ${SYNC_FORCE ? "--force" : ""}`);
    } catch (e) {
      console.error(`    !! failed to sync ${branch}: ${e.message}`);
    }
  }

  const forkBranches = getBranches(forkRepo);
  const deleted = forkBranches.filter((b) => !upstreamBranches.includes(b));

  if (deleted.length === 0) {
    console.log("  -> no extra branches to consider deleting.");
    return;
  }

  console.log("  -> branches existing in fork but deleted upstream:");
  for (const b of deleted) console.log(`     - ${b}`);

  for (const branch of deleted) {
    const ans = await ask(`  ? Delete branch '${branch}' from ${forkRepo} (y/N): `);
    if (/^y(es)?$/i.test(ans)) {
      try {
        sh(`gh api -X DELETE repos/${forkRepo}/git/refs/heads/${branch}`);
        console.log(`     -> deleted '${branch}'.`);
      } catch {
        console.warn(`     !! failed to delete ${branch}, maybe protected or permission denied`);
      }
    } else {
      console.log(`     -> kept '${branch}'.`);
    }
  }
}

async function main() {
  const listJson = sh(`gh repo list ${ORG} --fork --visibility public --json owner,name,parent`);
  const repos = JSON.parse(listJson);

  for (const r of repos) {
    const forkRepo = `${r.owner.login}/${r.name}`;
    const upstreamRepo = `${r.parent.owner.login}/${r.parent.name}`;
    await syncRepo(forkRepo, upstreamRepo);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});