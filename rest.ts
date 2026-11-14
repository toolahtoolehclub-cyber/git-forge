// GitHub REST v3: repositories, branches, commits, refs and contents. Every
// reply is JSON with a non-empty X-GitHub-Request-Id; errors are JSON
// {message}; unknown routes are 404 JSON. Repos belong to the viewer login
// the token names — any other owner is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitHistory } from './git.ts';
import {
  addComment,
  branchJson,
  commentJson,
  commitJson,
  createIssue,
  createPull,
  deleteContents,
  issueJson,
  mergePull,
  pullFileChanges,
  pullJson,
  repoJson,
  treeAtCommit,
  writeContents,
  type Repo,
  type Store,
} from './store.ts';
import {
  isRecord,
  nextRequestId,
  parseJsonBody,
  readBody,
  requireAuth,
  sendError,
  sendJson,
} from './http-util.ts';

export interface RestContext {
  store: Store;
  token: string;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  params: Map<string, string>;
}

const SCOPES = 'repo, read:org, user';

function scopes(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  sendJson(res, status, value, { 'x-oauth-scopes': SCOPES, ...extra });
}

function repoOf(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== ctx.store.viewerLogin) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function linkHeader(req: IncomingMessage, basePath: string, perPage: number, page: number, total: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => `http://${host}${basePath}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`);
  if (lastPage > 1) links.push(`<${url(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`);
  return links.join(', ');
}

function pageOf(params: Map<string, string>): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(params.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Route a request under /api/v3. Returns true when handled. */
export async function handleRest(ctx: RestContext): Promise<boolean> {
  const { req, res, segments } = ctx;
  const method = req.method ?? 'GET';
  const viewer = requireAuth(req, res, ctx.token, ctx.store.viewerLogin);
  if (viewer === null) return true;

  // GET /api/v3/ — the API root.
  if (segments.length === 2 && method === 'GET') {
    scopes(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    scopes(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    scopes(res, 200, { login: viewer, id: 1000, type: 'User' });
    return true;
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageOf(ctx.params);
      const all = ctx.store.listReposForOwner(viewer);
      const items = paginate(all, perPage, page).map((repo) => repoJson(ctx.store, repo));
      const link = linkHeader(req, '/api/v3/user/repos', perPage, page, all.length);
      scopes(res, 200, items, link === '' ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        sendError(res, 422, 'Validation Failed: name is invalid');
        return true;
      }
      if (ctx.store.getRepo(viewer, name) !== undefined) {
        sendError(res, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
      const isPrivate = parsed.value.private === true;
      const repo = ctx.store.createRepo(viewer, name, description, isPrivate);
      scopes(res, 201, repoJson(ctx.store, repo));
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    return handleRepoRoutes(ctx, segments[3] as string, segments[4] as string, segments.slice(5));
  }

  return false;
}

async function handleRepoRoutes(
  ctx: RestContext,
  owner: string,
  name: string,
  rest: string[],
): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  const repo = repoOf(ctx, owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      scopes(res, 200, repoJson(ctx.store, repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      scopes(res, 200, repoJson(ctx.store, repo));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId(), 'x-oauth-scopes': SCOPES });
      res.end();
      return true;
    }
    return false;
  }

  const section = rest[0] as string;

  if (section === 'branches') return handleBranches(ctx, repo, rest.slice(1));
  if (section === 'commits') return handleCommits(ctx, repo);
  if (section === 'git') return handleGitRefs(ctx, repo, rest.slice(1));
  if (section === 'contents') return handleContents(ctx, repo, rest.slice(1));
  if (section === 'labels') return handleLabels(ctx, repo);
  if (section === 'issues') return handleIssues(ctx, repo, rest.slice(1));
  if (section === 'pulls') return handlePulls(ctx, repo, rest.slice(1));
  return false;
}

async function handleBranches(ctx: RestContext, repo: Repo, rest: string[]): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  if (method !== 'GET') return false;
  const branches: Array<{ name: string; sha: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), sha: oid });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (rest.length === 0) {
    scopes(res, 200, branches.map((branch) => branchJson(branch.name, branch.sha)));
    return true;
  }
  const branchName = rest.join('/');
  const found = branches.find((branch) => branch.name === branchName);
  if (found === undefined) {
    sendError(res, 404, 'Branch not found');
    return true;
  }
  scopes(res, 200, branchJson(found.name, found.sha));
  return true;
}

async function handleCommits(ctx: RestContext, repo: Repo): Promise<boolean> {
  const { res } = ctx;
  if ((ctx.req.method ?? 'GET') !== 'GET') return false;
  const ref = ctx.params.get('sha') ?? repo.defaultBranch;
  const tip = ctx.store.resolveRef(repo, ref);
  if (tip === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const history = commitHistory(ctx.store.objectStoreOf(repo), tip);
  const { perPage, page } = pageOf(ctx.params);
  const items = paginate(history, perPage, page)
    .map((sha) => commitJson(ctx.store, repo, sha))
    .filter((item): item is Record<string, unknown> => item !== null);
  scopes(res, 200, items);
  return true;
}

async function handleGitRefs(ctx: RestContext, repo: Repo, rest: string[]): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  // POST /git/refs — create a ref.
  if (rest.length === 1 && rest[0] === 'refs' && method === 'POST') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      sendError(res, 422, 'Validation Failed: ref and sha are required');
      return true;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Validation Failed: Reference already exists');
      return true;
    }
    const object = repo.objects.get(sha);
    if (object === undefined) {
      sendError(res, 422, 'Validation Failed: sha does not exist');
      return true;
    }
    repo.refs.set(ref, sha);
    scopes(res, 201, {
      ref,
      node_id: '',
      url: '',
      object: { sha, type: object.type, url: '' },
    });
    return true;
  }
  // GET /git/refs/{ref...} — read one ref.
  if (rest.length >= 2 && rest[0] === 'refs' && method === 'GET') {
    const ref = `refs/${rest.slice(1).join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const object = repo.objects.get(oid);
    scopes(res, 200, {
      ref,
      node_id: '',
      url: '',
      object: { sha: oid, type: object?.type ?? 'commit', url: '' },
    });
    return true;
  }
  return false;
}

async function handleContents(ctx: RestContext, repo: Repo, rest: string[]): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  const path = rest.join('/');
  if (path === '' && method !== 'GET') return false;
  const branch = ctx.params.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = ctx.store.resolveRef(repo, branch);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const flat = treeAtCommit(ctx.store, repo, tip);
    if (flat === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const blobOid = flat.get(path);
    if (blobOid !== undefined) {
      const blob = repo.objects.get(blobOid);
      const content = blob?.data ?? Buffer.alloc(0);
      scopes(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() ?? path,
        path,
        content: content.toString('base64'),
        sha: blobOid,
      });
      return true;
    }
    // A directory: list the entries directly under this path ('' is the root).
    const prefix = path === '' ? '' : `${path}/`;
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [filePath, oid] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = repo.objects.get(oid);
        entries.push({ type: 'file', name: rest, path: filePath, sha: oid, size: blob?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '', size: 0 });
        }
      }
    }
    if (entries.length === 0) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    scopes(res, 200, entries);
    return true;
  }

  if (method === 'PUT') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
    const content = typeof parsed.value.content === 'string' ? parsed.value.content : '';
    const targetBranch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (message === '') {
      sendError(res, 422, 'Validation Failed: message is required');
      return true;
    }
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(content, 'base64');
    } catch {
      sendError(res, 422, 'Validation Failed: content is not valid base64');
      return true;
    }
    const tip = ctx.store.branchTip(repo, targetBranch);
    const flat = tip === null ? new Map<string, string>() : treeAtCommit(ctx.store, repo, tip) ?? new Map<string, string>();
    const current = flat.get(path);
    if (current !== undefined) {
      if (sha === undefined) {
        sendError(res, 422, 'Validation Failed: sha is required when updating a file');
        return true;
      }
      if (sha !== current) {
        sendError(res, 409, 'The file does not match the sha provided');
        return true;
      }
    }
    const written = writeContents(ctx.store, repo, targetBranch, path, contentBytes, message);
    scopes(res, written.created ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: written.blobSha,
        size: contentBytes.length,
        encoding: 'base64',
      },
      commit: { sha: written.commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
    const targetBranch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const tip = ctx.store.branchTip(repo, targetBranch);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const flat = treeAtCommit(ctx.store, repo, tip);
    const current = flat?.get(path);
    if (current === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (sha !== '' && sha !== current) {
      sendError(res, 409, 'The file does not match the sha provided');
      return true;
    }
    const commit = deleteContents(ctx.store, repo, targetBranch, path, message);
    if (commit === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    scopes(res, 200, { commit: { sha: commit, message } });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- labels, issues, pulls

async function handleLabels(ctx: RestContext, repo: Repo): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    scopes(res, 200, labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })));
    return true;
  }
  if (method === 'POST') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : '000000';
    const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return true;
    }
    if (repo.labels.has(name)) {
      sendError(res, 422, 'Validation Failed: label already exists');
      return true;
    }
    const label = { id: ctx.store.nextRestId(), name, color, description };
    repo.labels.set(name, label);
    scopes(res, 201, { id: label.id, name, color, description });
    return true;
  }
  return false;
}

async function handleIssues(ctx: RestContext, repo: Repo, rest: string[]): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  // /issues — list or create.
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.params.get('state') ?? 'open';
      const direction = ctx.params.get('direction') ?? 'desc';
      const { perPage, page } = pageOf(ctx.params);
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const items = paginate(issues, perPage, page).map((issue) => issueJson(ctx.store, repo, issue));
      const link = linkHeader(req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, perPage, page, issues.length);
      scopes(res, 200, items, link === '' ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      const issueBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      const labels = Array.isArray(parsed.value.labels)
        ? parsed.value.labels.filter((label): label is string => typeof label === 'string')
        : [];
      if (title === '') {
        sendError(res, 422, 'Validation Failed: title is required');
        return true;
      }
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
          return true;
        }
      }
      const issue = createIssue(ctx.store, repo, title, issueBody, labels);
      scopes(res, 201, issueJson(ctx.store, repo, issue));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      scopes(res, 200, issue.comments.map((comment) => commentJson(ctx.store, repo, comment)));
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const commentBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      if (commentBody === '') {
        sendError(res, 422, 'Validation Failed: body is required');
        return true;
      }
      const comment = addComment(ctx.store, issue, commentBody);
      scopes(res, 201, commentJson(ctx.store, repo, comment));
      return true;
    }
    return false;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      scopes(res, 200, issueJson(ctx.store, repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      if (Array.isArray(parsed.value.labels)) {
        const labels = parsed.value.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
            return true;
          }
        }
        issue.labels = labels;
      }
      scopes(res, 200, issueJson(ctx.store, repo, issue));
      return true;
    }
    return false;
  }
  return false;
}

async function handlePulls(ctx: RestContext, repo: Repo, rest: string[]): Promise<boolean> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  // /pulls — list or create.
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.params.get('state') ?? 'open';
      const { perPage, page } = pageOf(ctx.params);
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const items = paginate(pulls, perPage, page).map((pull) => pullJson(ctx.store, repo, pull));
      scopes(res, 200, items);
      return true;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      const pullBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
      const base = typeof parsed.value.base === 'string' ? parsed.value.base : '';
      if (title === '' || head === '' || base === '') {
        sendError(res, 422, 'Validation Failed: title, head and base are required');
        return true;
      }
      const headSha = ctx.store.branchTip(repo, head);
      const baseSha = ctx.store.branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        sendError(res, 422, 'Validation Failed: head or base branch does not exist');
        return true;
      }
      const pull = createPull(ctx.store, repo, title, pullBody, head, base, headSha, baseSha);
      scopes(res, 201, pullJson(ctx.store, repo, pull));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  const pull = repo.pulls.get(number);

  // /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return false;
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const files = pullFiles(ctx.store, repo, pull);
    scopes(res, 200, files);
    return true;
  }

  // /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return false;
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (pull.state !== 'open') {
      sendError(res, 405, 'Pull request is already merged or closed');
      return true;
    }
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    let message: string | undefined;
    if (parsed.ok && isRecord(parsed.value) && typeof parsed.value.commit_message === 'string') {
      message = parsed.value.commit_message;
    }
    const outcome = mergePull(ctx.store, repo, pull, message);
    if (!outcome.ok) {
      if (outcome.conflict) {
        sendError(res, 405, 'Merge conflict: this branch has conflicts that must be resolved');
        return true;
      }
      sendError(res, 422, outcome.message);
      return true;
    }
    scopes(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  if (rest.length === 1) {
    if (method !== 'GET') return false;
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    scopes(res, 200, pullJson(ctx.store, repo, pull));
    return true;
  }
  return false;
}

/** The files a pull request changes, diffed against its merge-base. */
function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  return pullFileChanges(store, repo, pull).map((change) => ({
    sha: change.sha,
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
  }));
}
