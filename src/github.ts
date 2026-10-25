import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

const API = 'https://api.github.com';
const TOKEN_MARGIN_MS = 5 * 60_000;
const JWT_LIFETIME_SECONDS = 540;
const JWT_SKEW_SECONDS = 60;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export class GitHubApp {
  private readonly key: KeyObject;
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<string, CachedToken>();

  constructor(
    private readonly appId: string,
    privateKey: string,
  ) {
    this.key = createPrivateKey(privateKey.replace(/\\n/g, '\n'));
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: now - JWT_SKEW_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: this.appId }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.key);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  private async send<T>(method: string, path: string, authorization: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleet-runner',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        message = text;
      }
      throw new GitHubError(response.status, `${method} ${path}: ${String(response.status)} ${message}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async installationId(repo: string): Promise<number> {
    const owner = repo.split('/')[0] ?? repo;
    const known = this.installations.get(owner);
    if (known !== undefined) {
      return known;
    }
    const installation = await this.send<{ id: number }>('GET', `/repos/${repo}/installation`, `Bearer ${this.jwt()}`);
    this.installations.set(owner, installation.id);
    return installation.id;
  }

  private async token(repo: string): Promise<string> {
    const owner = repo.split('/')[0] ?? repo;
    const cached = this.tokens.get(owner);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
      return cached.token;
    }
    const id = await this.installationId(repo);
    const created = await this.send<{ token: string; expires_at: string }>('POST', `/app/installations/${String(id)}/access_tokens`, `Bearer ${this.jwt()}`);
    this.tokens.set(owner, { token: created.token, expiresAt: Date.parse(created.expires_at) });
    return created.token;
  }

  async request<T>(method: string, repo: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.send<T>(method, `/repos/${repo}${path}`, `token ${await this.token(repo)}`, body);
    } catch (cause) {
      if (cause instanceof GitHubError && cause.status === 401) {
        const owner = repo.split('/')[0] ?? repo;
        this.tokens.delete(owner);
        this.installations.delete(owner);
      }
      throw cause;
    }
  }
}
