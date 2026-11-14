// The HTTP server: one router over the shared store. /healthz takes no auth;
// every other surface checks the bearer token first, then the resource.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { executeGraphQLBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestContext } from './rest.ts';
import type { Store } from './store.ts';
import {
  parseJsonBody,
  pathSegments,
  queryParams,
  readBody,
  requireAuth,
  sendError,
  sendJson,
} from './http-util.ts';

export interface AppOptions {
  store: Store;
  token: string;
}

export function createApp(options: AppOptions): Server {
  const { store, token } = options;
  return createServer((req, res) => {
    void handleRequest(store, token, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        } catch {
          // The socket is gone; nothing left to do.
        }
      } else {
        try {
          res.end();
        } catch {
          // Ignore.
        }
      }
    });
  });
}

async function handleRequest(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // req.url is always origin-form here; split it by hand instead of building
  // a URL object per request (URL parsing is one of the costlier per-request
  // steps, and this runs on every single request).
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
  const search = qIndex < 0 ? '' : rawUrl.slice(qIndex);
  const segments = pathSegments(pathname);
  const method = req.method ?? 'GET';

  // GET /healthz — the boot check; no auth.
  if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // /api/v3/...
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    const ctx: RestContext = {
      store,
      token,
      req,
      res,
      segments,
      params: queryParams(search),
    };
    const handled = await handleRest(ctx);
    if (!handled) sendError(res, 404, 'Not Found');
    return;
  }

  // POST /api/graphql
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    const viewer = requireAuth(req, res, token, store.viewerLogin);
    if (viewer === null) return;
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const result = executeGraphQLBody(store, parsed.value);
    sendJson(res, 200, result);
    return;
  }

  // /mcp
  if (segments.length === 1 && segments[0] === 'mcp') {
    await handleMcp(store, req, res, token);
    return;
  }

  // /{owner}/{repo}.git/...
  if (
    segments.length >= 3 &&
    (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
  ) {
    await handleGit(store, token, req, res, segments, search);
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function handleGit(
  store: Store,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  search: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const repoName = repoSegment.slice(0, -'.git'.length);
  const viewer = requireAuth(req, res, token, store.viewerLogin);
  if (viewer === null) return;
  if (owner !== viewer) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const action = segments[2] as string;
  if (action === 'info' && segments[3] === 'refs' && method === 'GET') {
    const service = queryParams(search).get('service') ?? '';
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    handleInfoRefs(store, repo, service, isV2, res);
    return;
  }
  if (action === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    handleUploadPack(repo, req, body, res);
    return;
  }
  if (action === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    await handleReceivePack(store, repo, body, res);
    return;
  }
  sendError(res, 404, 'Not Found');
}
