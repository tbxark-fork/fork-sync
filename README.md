# fork-sync

Hourly sync of every public fork under an organization with its upstream repository.

The latest run — when it happened, and which branches were synced, created, deleted,
filtered or failed per repository — is written to [SYNC.md](./SYNC.md) and committed
by the workflow.

## Usage

```sh
gh auth login          # or export GH_TOKEN=<pat>
node ./sync.js
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SYNC_ORG` | `tbxark-fork` | Organization/user whose public forks are synced. |
| `SYNC_BRANCH_FILTER` | `^dependabot/\|^renovate/\|^copilot/\|^coderabbitai/\|^backups?/\|sparkle` | Branches matching this regex are never created in the fork, and are deleted without asking once they disappear upstream. |
| `SYNC_MAX_BRANCHES` | `100` | Max sync/create operations per repo per run; the rest are deferred to the next run and listed in the report. |
| `SYNC_CONCURRENCY` | `4` | Branch operations in flight per repository. |
| `SYNC_REPO_LIMIT` | `1000` | Max repositories fetched from `gh repo list`. |
| `SYNC_TIMEOUT_MS` | `120000` | Timeout per `gh` invocation. |
| `SYNC_REPORT_FILE` | `SYNC.md` | Where the run report is written. |
| `SYNC_CREATE_MISSING` | `true` | Create fork branches that only exist upstream. |
| `SYNC_DELETE_REMOVED` | `false` | Delete *all* fork branches missing upstream, not just filtered ones. |
| `SYNC_FORCE` | `false` | Always `gh repo sync --force`. |
| `SYNC_DRY_RUN` | `false` | Print the writes without performing them. |
| `SYNC_NON_INTERACTIVE` | `false` | Never prompt; also implied when stdin is not a TTY. |

Branches are compared by head SHA first, so unchanged branches cost no API calls.
