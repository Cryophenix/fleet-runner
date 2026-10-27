# fleet-runner

- Serves GitHub Actions jobs for the repositories in `WATCH_REPOS`: polls them, starts a one-job runner (just-in-time registration) per queued job, removes it after; nothing stays registered.
- One instance per server (theo-vps, Coolify); the orchestrator wires which repositories each one watches.
- Jobs must ask for `runs-on: [self-hosted, fleet]`.
- Settings: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the fleet-runners App, Administration RW, Actions R and Contents R on repositories), `WATCH_REPOS`, `RUNNER_NAME`, `MAX_JOBS` (2), `RUNNER_LABELS` (fleet), `POLL_SECONDS` (30), `JOB_ENV` (JSON of job variables per repository or `*`), `FRAMEWORK_REPO` (Cryophenix/my-framework), `PORT` (8080).
- Every job gets `FRAMEWORK_TOKEN`, a one-hour read-only token for `FRAMEWORK_REPO`, so workflows can fetch the private framework submodule.
- `GET /health`: what it watches and runs; 503 when no poll succeeded for 5 minutes.
- A runner that gets no job within 10 minutes is removed; on stop, running jobs get 10 minutes.
