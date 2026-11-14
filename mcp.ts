// Model Context Protocol over streamable HTTP: JSON-RPC 2.0, plain JSON
// replies, the 2026-07-28 discovery handshake and the legacy initialize
// handshake, six tools over the same store REST uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssue,
  createPull,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  type Store,
} from './store.ts';
import { isRecord, readBody, sendError, sendJson } from './http-util.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolTextResult(object: unknown): Record<string, unknown> {
  const text = JSON.stringify(object);
  return { content: [{ type: 'text', text }], structuredContent: object };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function argString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function argNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

/** Dispatch one tools/call by name. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { __rpcError: -32602, __message: `unknown tool ${name}` };
  }
  const missing = missingRequired(args, tool.inputSchema.required);
  if (missing !== null) {
    return toolErrorResult(`missing required argument: ${missing}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name') as string;
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolErrorResult('invalid repository name');
      if (store.getRepo(store.viewerLogin, repoName) !== undefined) {
        return toolErrorResult(`repository ${store.viewerLogin}/${repoName} already exists`);
      }
      const repo = store.createRepo(
        store.viewerLogin,
        repoName,
        argString(args, 'description') ?? '',
        args.private === true,
      );
      return toolTextResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const owner = argString(args, 'owner') as string;
      const repoName = argString(args, 'repo') as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`repository ${owner}/${repoName} not found`);
      return toolTextResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const owner = argString(args, 'owner') as string;
      const repoName = argString(args, 'repo') as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`repository ${owner}/${repoName} not found`);
      const labels = Array.isArray(args.labels)
        ? (args.labels as unknown[]).filter((label): label is string => typeof label === 'string')
        : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return toolErrorResult(`label "${label}" does not exist`);
      }
      const issue = createIssue(store, repo, argString(args, 'title') as string, argString(args, 'body') ?? '', labels);
      return toolTextResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const owner = argString(args, 'owner') as string;
      const repoName = argString(args, 'repo') as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`repository ${owner}/${repoName} not found`);
      const state = argString(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      const listed = issues.map((issue) => issueJson(store, repo, issue));
      return toolTextResult({ issues: listed });
    }
    case 'create_pull_request': {
      const owner = argString(args, 'owner') as string;
      const repoName = argString(args, 'repo') as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`repository ${owner}/${repoName} not found`);
      const head = argString(args, 'head') ?? argString(args, 'headRefName') ?? '';
      const base = argString(args, 'base') ?? argString(args, 'baseRefName') ?? '';
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        return toolErrorResult('head or base branch does not exist');
      }
      const pull = createPull(store, repo, argString(args, 'title') as string, argString(args, 'body') ?? '', head, base, headSha, baseSha);
      return toolTextResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const owner = argString(args, 'owner') as string;
      const repoName = argString(args, 'repo') as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult(`repository ${owner}/${repoName} not found`);
      const number = argNumber(args, 'pull_number') ?? argNumber(args, 'number');
      if (number === undefined) return toolErrorResult('missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolErrorResult(`pull request #${number} not found`);
      const outcome = mergePull(store, repo, pull);
      if (!outcome.ok) {
        return toolErrorResult(outcome.conflict ? 'merge conflict' : outcome.message);
      }
      return toolTextResult({
        number: pull.number,
        pull_number: pull.number,
        merged: true,
        sha: outcome.sha,
        state: 'closed',
        ...pullJson(store, repo, pull),
      });
    }
    default:
      return { __rpcError: -32602, __message: `unknown tool ${name}` };
  }
}

/** Handle one JSON-RPC request object. */
function handleRpc(store: Store, request: RpcRequest, res: ServerResponse): void {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'ping') {
    rpcResult(res, id, {});
    return;
  }
  if (method === 'tools/list') {
    // The tool list is a fixed constant, so two calls serialize identically.
    rpcResult(res, id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = callTool(store, name, args);
    if (isRecord(outcome) && typeof outcome.__rpcError === 'number') {
      rpcError(res, 200, id, outcome.__rpcError as number, String(outcome.__message ?? 'tool error'));
      return;
    }
    rpcResult(res, id, outcome);
    return;
  }
  rpcError(res, 200, id, -32601, `unknown method ${method}`);
}

/** POST /mcp (and DELETE /mcp, which always answers 200). */
export async function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{}');
    return;
  }
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }
  const header = req.headers.authorization;
  if (header === undefined || header === '' || !/^Bearer /.test(header) || header.slice('Bearer '.length) !== token) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700, keeping the id when readable.
    let id: unknown = null;
    const match = /"id"\s*:\s*("[^"]*"|-?\d+|null)/.exec(raw.toString('utf8'));
    if (match !== null) {
      const tokenText = match[1] as string;
      if (tokenText === 'null') id = null;
      else if (tokenText.startsWith('"')) id = tokenText.slice(1, -1);
      else id = Number(tokenText);
    }
    rpcError(res, 400, id, -32700, 'Parse error');
    return;
  }
  if (!isRecord(parsed)) {
    rpcError(res, 400, null, -32600, 'Invalid Request');
    return;
  }
  handleRpc(store, parsed as RpcRequest, res);
}
