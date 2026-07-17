# Yana Sandbox — Composite GitHub Action

Run the full [Yana](https://github.com/JetBrains/junie-live-fake) sandbox (proxies + agent
container) inside a GitHub Actions job. The action installs the published `yana`
CLI, logs in to GHCR, injects your secrets into a temporary `.env` file, and runs
the sandbox for a bounded, self-restarting window.

```yaml
# Mint a short-lived, repo-scoped installation token from the Yana App
# (its private key stays in the Actions secret store, never in the sandbox).
- id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.YANA_APP_ID }}
    private-key: ${{ secrets.YANA_APP_PRIVATE_KEY }}

- uses: jetbrains/junie-live-fake/.github/actions/yana-sandbox@main
  with:
    agent: junie-test
    run-duration-seconds: "18000"  # up to 5h (GitHub job cap is ~6h)
    ghcr-token: ${{ secrets.GHCR_TOKEN }}
    # Every secret / config value reaches the sandbox as a KEY=VALUE line here
    # (canonical env keys — see .env.example). The sandbox stays secretless.
    configuration-envs: |
      OPENROUTER_API_KEY=${{ secrets.OPENROUTER_API_KEY }}
      # Only the ~1h installation token enters the sandbox — not the App key.
      GIT_TOKEN=${{ steps.app-token.outputs.token }}
      GITHUB_MCP_TOKEN=${{ steps.app-token.outputs.token }}
      YANA_TOKEN_SECRET=${{ secrets.YANA_TOKEN_SECRET }}
      BOT_USER_ACCESS_TOKEN=${{ secrets.BOT_USER_ACCESS_TOKEN }}
      SLACK_APP_TOKEN=${{ secrets.SLACK_APP_TOKEN }}
```

## How it works

1. **Install CLI** — installs the `yana` CLI (via the repo `install.sh`, or a
   pinned release asset when `yana-version` is set), using the job's
   `github.token` to fetch the release.
2. **GHCR login** — logs in to `ghcr.io` with `ghcr-token` so the private
   `ghcr.io/jetbrains/yana/*` images can be pulled.
3. **Generate `.env`** — writes the `configuration-envs` `KEY=VALUE` lines
   (plus any from the deprecated `extra-secrets` alias) to a `chmod 600` temp
   file (keys match `.env.example`). Secrets land only in this proxy-facing
   file; the agent container keeps zero credentials.
4. **Supervised run** — `run-sandbox.sh` runs
   `yana --env-file <env> --agent <agent> yana.yaml` in the foreground under
   `timeout -s INT <budget>`. If `yana` exits early it tears the stack down and
   restarts until `run-duration-seconds` elapses, then does a final `down`.

Continuous operation across hours comes from the **caller workflow's schedule**
(see `examples/junie-agent/yana-sandbox.yml`): each cron tick launches a fresh
sandbox; the internal supervisor recovers from crashes within the run. A single
run can be up to **5 hours** (`run-duration-seconds: "18000"`) — GitHub caps a
job at ~6h, so a 5h budget plus install/teardown headroom (`timeout-minutes: 330`)
stays under the limit. The example schedule runs every 5 hours to match.

## Logs

The CLI accepts a `--log-file <path>` flag that writes its full session log —
docker output plus the streamed status events — to a chosen absolute path. The
action uses this automatically: each `yana` invocation is launched with
`--log-file <runner-temp>/yana-logs/yana-run-NNN.log` (one file per supervisor
attempt). The same output also streams to **stdout**, so it is visible **live**
in the running job's log. After the run (and even on failure, via `always()`),
the log directory is uploaded as the **`yana-logs`** job artifact, so users can
**download** the complete logs from the workflow run page. The log location is
not configurable on the action (only on the CLI's `--log-file`); the action just
surfaces it to the user.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `agent` | yes | — | Agent name; selects `.yana/<agent>/agent.yaml` in the caller repo. |
| `yana-version` | no | `latest` | yana CLI release tag, or `latest`. |
| `working-directory` | no | `.` | Directory containing the caller's `yana.yaml`. |
| `run-duration-seconds` | no | `3600` | Per-run time budget; restarted on early exit until elapsed. |
| `configuration-envs` | no | `""` | Newline-separated `KEY=VALUE` pairs written to the proxy-facing `.env`; **all** secrets and config env vars go here (see below). |
| `extra-secrets` | no | `""` | **DEPRECATED** — use `configuration-envs`. Accepted for one release as an alias (its lines merged after `configuration-envs`, with a deprecation warning). |
| `ghcr-token` | no | `""` | Token with `read:packages` for private images. |

## Configuration environment (`configuration-envs`)

All secrets and configuration env vars reach the sandbox through the single
`configuration-envs` input — newline-separated `KEY=VALUE` pairs written to the
`chmod 600` proxy-facing `.env`. Write the **canonical env keys** the proxies /
CLI read (the same names as a local `.env`; see `.env.example`), anything Yana's
configs (`yana.yaml`, `agent.yaml`, `mcp.json`) reference through their **open
`${VAR}` namespace** (e.g. `${NOTION_TOKEN}`, `${JIRA_TOKEN}`), and any
non-secret configuration (e.g. `YANA_LIVE_OVERRIDE_PROJECT_ID`):

```yaml
- uses: jetbrains/junie-live-fake/.github/actions/yana-sandbox@main
  with:
    agent: junie-test
    ghcr-token: ${{ secrets.GHCR_TOKEN }}
    configuration-envs: |
      OPENROUTER_API_KEY=${{ secrets.OPENROUTER_API_KEY }}
      GIT_TOKEN=${{ steps.app-token.outputs.token }}
      GITHUB_MCP_TOKEN=${{ steps.app-token.outputs.token }}
      NOTION_TOKEN=${{ secrets.NOTION_TOKEN }}
      JIRA_TOKEN=${{ secrets.JIRA_TOKEN }}
```

Each non-empty line is validated (`^[A-Za-z_][A-Za-z0-9_]*=`), masked in logs
with `::add-mask::`, and appended to the `chmod 600` proxy-facing `.env` — so
secrets still land only in the proxies and the sandbox stays secretless and
egress-gated. Blank lines and `#`-comments are ignored; malformed lines and
lines with empty values are skipped. Reference each key in your committed
`yana.yaml` / `agent.yaml` / `mcp.json` as `${KEY}`. Adding a secret is a
one-line caller change (add a repo secret + one `KEY=...` line) with zero
action/release churn.

**Raw multi-line PEMs are auto-normalized.** The `.env` is line-based and
cannot carry a multi-line value, so a raw multi-line PEM (a `KEY=-----BEGIN...`
line followed by continuation lines up to `-----END...`) is **collected** by the
action's parser and written as a **single-line base64-encoded value** — which
`git-proxy`/`mcp-proxy` accept transparently. This lets a caller paste a
`GITHUB_APP_PRIVATE_KEY` repo secret verbatim (e.g.
`GITHUB_APP_PRIVATE_KEY=${{ secrets.YANA_APP_PRIVATE_KEY }}`) without a
pre-processing step. For stability across YAML/secret-store round-trips, prefer
**pre-encoding once** (`base64 -w0 key.pem`) and passing the resulting
single-line value.

### Migrating from the old named inputs

Earlier versions of this action had a typed input per secret. Those inputs are
removed; pass each as a `configuration-envs` line using its env key:

| Former input | `configuration-envs` line |
| --- | --- |
| `openrouter-api-key` | `OPENROUTER_API_KEY=...` |
| `openai-api-key` | `OPENAI_API_KEY=...` |
| `anthropic-api-key` | `ANTHROPIC_API_KEY=...` |
| `github-app-id` | `GITHUB_APP_ID=...` |
| `github-app-private-key` | `GITHUB_APP_PRIVATE_KEY=...` (raw multi-line PEM auto-normalized; base64 preferred) |
| `github-app-installation-id` | `GITHUB_APP_INSTALLATION_ID=...` |
| `git-token` | `GIT_TOKEN=...` |
| `yana-token-secret` | `YANA_TOKEN_SECRET=...` |
| `yana-live-backend-token` | `YANA_LIVE_BACKEND_TOKEN=...` |
| `slack-bot-token` | `BOT_USER_ACCESS_TOKEN=...` |
| `slack-app-token` | `SLACK_APP_TOKEN=...` |
| `web-search-mcp-token` | `WEB_SEARCH_TOKEN=...` |
| `github-mcp-token` | `GITHUB_MCP_TOKEN=...` |

The `extra-secrets` input is **deprecated** but still accepted for one release:
its lines are merged after `configuration-envs` (with a deprecation warning), so
just rename the key to `configuration-envs`.

## Repo identity (config-only)

The repository the sandbox operates on is defined **exclusively** in the caller's
committed config — the action does not configure it and cannot override it. Set
it in your `yana.yaml` (or `.yana/<agent>/agent.yaml`):

```yaml
git:
  repo_url: "https://github.com/your-org/your-repo.git"
  branch: "main"
```

This keeps a single canonical source of truth for the repo, avoiding the
duplicate-clone problem that arose when the action injected a differently-cased
GitHub-context URL alongside the hand-written one.

## Git credentials (use a short-lived App token)

Do **not** forward the GitHub App **private key** into the sandbox — it is an
org-wide shared secret that can mint tokens for every installation of the App.
Instead, because the Yana App is installed in the calling repo, mint a
**short-lived, repo-scoped installation token** on the runner with the official
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
and pass only that token in as the `GIT_TOKEN` (and `GITHUB_MCP_TOKEN`) lines:

```yaml
- id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.YANA_APP_ID }}
    private-key: ${{ secrets.YANA_APP_PRIVATE_KEY }}

- uses: jetbrains/junie-live-fake/.github/actions/yana-sandbox@main
  with:
    agent: junie-test
    configuration-envs: |
      GIT_TOKEN=${{ steps.app-token.outputs.token }}
      GITHUB_MCP_TOKEN=${{ steps.app-token.outputs.token }}
      # ...other KEY=VALUE lines...
```

The token is scoped to the installation and expires in ~1h. A fresh token is
minted on every scheduled run. The CLI's existing `GIT_TOKEN` code path consumes
it unchanged, so the `git.token` branch of `validate.go` is satisfied and the
`GITHUB_APP_*` lines are not needed. **For runs longer than the ~1h token
lifetime** (e.g. the 5-hour `run-duration-seconds: "18000"` budget) git
operations stop working once the token expires; supply the `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` lines instead (the
App-credentials path auto-refreshes the token in-sandbox) if you need git access
for the full window — at the cost of forwarding the private key into the
sandbox. `GITHUB_APP_PRIVATE_KEY` may be pasted as a **raw multi-line PEM** (the
action auto-normalizes it to single-line base64) or as a **pre-encoded** value
(`base64 -w0 key.pem`); pre-encoding is preferred for stability.

For same-repo-only access you can instead pass the workflow's built-in
`${{ github.token }}` (with `permissions: { contents: write }`) as the
`GIT_TOKEN` line; use the App token when you need the **Yana App identity** on
commits/PRs or **cross-repo** access.

## Caller responsibilities

- Commit your own `yana.yaml` (LLM provider; `git.repo_url`/`branch` set
  explicitly) and `.yana/<agent>/` (`agent.yaml` + `mcp.json`) in the calling
  repo, mirroring local usage. The action does **not** template config or
  configure the repository — it only injects secrets and selects the agent.
- Provide a `ghcr-token` with `read:packages` on the `jetbrains` org while the
  images are private.

## Notes / limitations

- Runs on `ubuntu-latest`, where Docker with `NET_ADMIN` is available for the
  egress-gateway.
- Each scheduled run starts fresh; cross-run state persistence is the agent's
  existing opt-in mechanism, not provided by this action.
- GitHub jobs are capped at ~6h and scheduled crons can be delayed under load;
  a 5-hour budget (`timeout-minutes: 330`) plus an every-5-hours schedule keeps
  each job within the limit.
- A short-lived App installation token (the `GIT_TOKEN` line) lasts ~1h; for the
  full 5h window supply the `GITHUB_APP_*` lines instead (auto-refreshes) if git
  access must outlive the token.
