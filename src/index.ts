import { createServer } from 'node:http';
import { GitHubApp } from './github.js';
import { Pool } from './pool.js';

const BASE_LABELS = ['self-hosted', 'linux', 'x64'];
const STALE_POLL_MS = 5 * 60_000;

interface Job {
  status: string;
  labels: string[];
  runner_name: string | null;
}

interface Config {
  appId: string;
  privateKey: string;
  repos: string[];
  maxJobs: number;
  runnerName: string;
  labels: string[];
  requiredLabels: string[];
  pollMs: number;
  jobEnv: Record<string, Record<string, string>>;
  port: number;
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const positive = (raw: string | undefined, fallback: number, name: string, problems: string[]): number => {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    problems.push(`${name} must be a positive whole number, got "${raw}"`);
    return fallback;
  }
  return value;
};

const parseJobEnv = (raw: string | undefined, problems: string[]): Record<string, Record<string, string>> => {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const result: Record<string, Record<string, string>> = {};
    for (const [scope, values] of Object.entries(parsed)) {
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw new Error(`${scope} is not an object`);
      }
      result[scope] = Object.fromEntries(Object.entries(values as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
    }
    return result;
  } catch (cause) {
    problems.push(`JOB_ENV must be JSON like {"owner/repo": {"KEY": "value"}, "*": {}}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return {};
  }
};

const readConfig = (): { config: Config; problems: string[] } => {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = process.env[name]?.trim() ?? '';
    if (value === '') {
      problems.push(`${name} is not set`);
    }
    return value;
  };
  const appId = required('GITHUB_APP_ID');
  const privateKey = required('GITHUB_APP_PRIVATE_KEY');
  const repos = list(process.env.WATCH_REPOS);
  if (repos.length === 0) {
    problems.push('WATCH_REPOS is not set (comma-separated owner/repo)');
  }
  for (const repo of repos.filter((entry) => !/^[\w.-]+\/[\w.-]+$/.test(entry))) {
    problems.push(`WATCH_REPOS: "${repo}" is not owner/repo`);
  }
  const runnerName = required('RUNNER_NAME');
  const requiredLabels = list(process.env.RUNNER_LABELS ?? 'fleet').map((label) => label.toLowerCase());
  const config: Config = {
    appId,
    privateKey,
    repos,
    maxJobs: positive(process.env.MAX_JOBS, 2, 'MAX_JOBS', problems),
    runnerName: runnerName.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    labels: [...new Set([...BASE_LABELS, ...requiredLabels])],
    requiredLabels,
    pollMs: positive(process.env.POLL_SECONDS, 30, 'POLL_SECONDS', problems) * 1000,
    jobEnv: parseJobEnv(process.env.JOB_ENV, problems),
    port: positive(process.env.PORT, 8080, 'PORT', problems),
  };
  return { config, problems };
};

const { config, problems } = readConfig();
const errors: Record<string, string> = {};
let lastPollAt: number | null = null;
let stopping = false;
let pool: Pool | null = null;

const ours = (job: Job): boolean => {
  const labels = job.labels.map((label) => label.toLowerCase());
  return labels.every((label) => config.labels.includes(label)) && config.requiredLabels.every((label) => labels.includes(label));
};

const jobsOf = async (github: GitHubApp, repo: string): Promise<Job[]> => {
  const runs = (
    await Promise.all(
      ['queued', 'in_progress'].map((status) =>
        github.request<{ workflow_runs: { id: number }[] }>('GET', repo, `/actions/runs?status=${status}&per_page=30`),
      ),
    )
  ).flatMap((page) => page.workflow_runs);
  const pages = await Promise.all(runs.map((run) => github.request<{ jobs: Job[] }>('GET', repo, `/actions/runs/${String(run.id)}/jobs?per_page=100`)));
  return pages.flatMap((page) => page.jobs);
};

const pollRepo = async (github: GitHubApp, active: Pool, repo: string): Promise<void> => {
  const jobs = await jobsOf(github, repo);
  const busy = new Set(jobs.filter((job) => job.status === 'in_progress' && job.runner_name !== null).map((job) => job.runner_name ?? ''));
  active.markBusy(busy);
  const queued = jobs.filter((job) => job.status === 'queued' && ours(job)).length;
  let idle = active.forRepo(repo).filter((child) => !child.busy).length;
  while (queued > idle && active.children.size < config.maxJobs && !stopping) {
    await active.spawn(repo);
    idle += 1;
  }
};

const poll = async (github: GitHubApp, active: Pool): Promise<void> => {
  let succeeded = false;
  for (const repo of config.repos) {
    try {
      await pollRepo(github, active, repo);
      Reflect.deleteProperty(errors, repo);
      succeeded = true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (errors[repo] !== message) {
        log(`${repo}: ${message}`);
      }
      errors[repo] = message;
    }
  }
  await active.reapIdle();
  if (succeeded) {
    lastPollAt = Date.now();
  }
};

const loop = async (github: GitHubApp, active: Pool): Promise<void> => {
  while (!stopping) {
    await poll(github, active).catch((cause: unknown) => {
      log(`poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
};

const health = (): { status: number; body: unknown } => {
  const fresh = lastPollAt !== null && Date.now() - lastPollAt < STALE_POLL_MS;
  return {
    status: fresh ? 200 : 503,
    body: {
      runner: config.runnerName,
      watching: config.repos,
      maxJobs: config.maxJobs,
      running: [...(pool?.children.values() ?? [])].map((child) => ({ repo: child.repo, name: child.name, since: new Date(child.since).toISOString(), busy: child.busy })),
      lastPollAt: lastPollAt === null ? null : new Date(lastPollAt).toISOString(),
      errors: problems.length > 0 ? { config: problems.join('; ') } : errors,
    },
  };
};

createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  const { status, body } = health();
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}).listen(config.port, () => {
  log(`health on :${String(config.port)}/health`);
});

if (problems.length > 0) {
  for (const problem of problems) {
    log(`config: ${problem}`);
  }
  log('not polling until the settings above are fixed');
} else {
  try {
    const github = new GitHubApp(config.appId, config.privateKey);
    pool = new Pool(github, config.runnerName, config.labels, config.jobEnv);
    const active = pool;
    log(`${config.runnerName} watching ${config.repos.join(', ')} with up to ${String(config.maxJobs)} jobs, labels ${config.labels.join(', ')}`);
    void loop(github, active);
  } catch (cause) {
    problems.push(`GITHUB_APP_PRIVATE_KEY is not a valid PEM private key: ${cause instanceof Error ? cause.message : String(cause)}`);
    log(`config: ${problems.at(-1) ?? ''}`);
  }
}

const shutdown = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  log('stopping: running jobs get up to 10 minutes');
  void (pool?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
