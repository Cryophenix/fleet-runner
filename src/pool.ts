import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { GitHubApp } from './github.js';

const RUNNER_HOME = '/opt/actions-runner';
const SLOTS = '/work/slots';
const TEMPLATE = '/work/runner';
const TEMPLATE_VERSION = '/work/runner.version';
const IDLE_LIMIT_MS = 10 * 60_000;
const STOP_GRACE_MS = 10 * 60_000;
const HIDDEN_ENV = ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_ID', 'JOB_ENV', 'FRAMEWORK_REPO'];

export interface Child {
  repo: string;
  name: string;
  runnerId: number;
  since: number;
  busy: boolean;
  process: ChildProcess;
  slot: string;
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`));
      }
    });
  });

const prepare = async (): Promise<void> => {
  await rm(SLOTS, { recursive: true, force: true });
  const version = process.env.RUNNER_VERSION ?? 'unknown';
  const current = await readFile(TEMPLATE_VERSION, 'utf8').catch(() => null);
  if (current === version) {
    return;
  }
  log(`copying the runner ${version} into the work volume`);
  await rm(TEMPLATE, { recursive: true, force: true });
  await mkdir(path.dirname(TEMPLATE), { recursive: true });
  await run('cp', ['-a', RUNNER_HOME, TEMPLATE]);
  await writeFile(TEMPLATE_VERSION, version, 'utf8');
};

const copyRunner = async (slot: string): Promise<void> => {
  await mkdir(SLOTS, { recursive: true });
  await run('cp', ['-al', TEMPLATE, slot]);
};

const pipeLines = (stream: NodeJS.ReadableStream | null, name: string): void => {
  if (stream === null) {
    return;
  }
  createInterface({ input: stream }).on('line', (line) => {
    log(`[${name}] ${line}`);
  });
};

export class Pool {
  readonly children = new Map<string, Child>();
  private template: Promise<void> | null = null;

  constructor(
    private readonly github: GitHubApp,
    private readonly runnerName: string,
    private readonly labels: string[],
    private readonly jobEnv: Record<string, Record<string, string>>,
    private readonly frameworkRepo: string,
  ) {}

  forRepo(repo: string): Child[] {
    return [...this.children.values()].filter((child) => child.repo === repo);
  }

  markBusy(names: Set<string>): void {
    for (const child of this.children.values()) {
      if (names.has(child.name)) {
        child.busy = true;
      }
    }
  }

  private async frameworkToken(): Promise<Record<string, string>> {
    try {
      return { FRAMEWORK_TOKEN: await this.github.readToken(this.frameworkRepo) };
    } catch (cause) {
      log(`jobs get no FRAMEWORK_TOKEN, ${this.frameworkRepo} is not readable: ${cause instanceof Error ? cause.message : String(cause)}`);
      return {};
    }
  }

  private async environment(repo: string): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(await this.frameworkToken()), ...this.jobEnv['*'], ...this.jobEnv[repo] };
    for (const name of HIDDEN_ENV) {
      Reflect.deleteProperty(env, name);
    }
    return env;
  }

  async spawn(repo: string): Promise<void> {
    const name = `${this.runnerName}-${repo.split('/')[1] ?? repo}-${randomBytes(3).toString('hex')}`.slice(0, 64);
    const created = await this.github.request<{ runner: { id: number }; encoded_jit_config: string }>('POST', repo, '/actions/runners/generate-jitconfig', {
      name,
      runner_group_id: 1,
      labels: this.labels,
      work_folder: '_work',
    });
    const slot = path.join(SLOTS, name);
    try {
      await rm(slot, { recursive: true, force: true });
      this.template ??= prepare().catch((cause: unknown) => {
        this.template = null;
        throw cause;
      });
      await this.template;
      await copyRunner(slot);
    } catch (cause) {
      await this.deleteRunner(repo, created.runner.id);
      throw cause;
    }
    const env = await this.environment(repo);
    const child = spawn(path.join(slot, 'run.sh'), ['--jitconfig', created.encoded_jit_config], {
      cwd: slot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry: Child = { repo, name, runnerId: created.runner.id, since: Date.now(), busy: false, process: child, slot };
    this.children.set(name, entry);
    child.on('error', (cause) => {
      log(`${name} could not run: ${cause.message}`);
    });
    pipeLines(child.stdout, name);
    pipeLines(child.stderr, name);
    log(`started ${name} for ${repo}`);
    child.on('exit', (code, signal) => {
      this.children.delete(name);
      log(`${name} exited (${signal ?? String(code)})`);
      void rm(slot, { recursive: true, force: true }).catch(() => undefined);
    });
  }

  async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const child of [...this.children.values()]) {
      if (!child.busy && now - child.since > IDLE_LIMIT_MS) {
        log(`${child.name} got no job in 10 minutes, removing it`);
        child.process.kill('SIGTERM');
        await this.deleteRunner(child.repo, child.runnerId);
      }
    }
  }

  private async deleteRunner(repo: string, id: number): Promise<void> {
    try {
      await this.github.request('DELETE', repo, `/actions/runners/${String(id)}`);
    } catch (cause) {
      log(`could not delete runner ${String(id)} of ${repo}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async stop(): Promise<void> {
    for (const child of [...this.children.values()].filter((entry) => !entry.busy)) {
      child.process.kill('SIGTERM');
      await this.deleteRunner(child.repo, child.runnerId);
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (this.children.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    for (const child of [...this.children.values()]) {
      child.process.kill('SIGKILL');
      await this.deleteRunner(child.repo, child.runnerId);
    }
  }
}

