// Small HTTP helpers shared by every surface: body reading, JSON replies,
// bearer auth against the shop token, and the request-id header every GitHub
// reply carries.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** The next request id: a plain counter, never in any exported state. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Read a request body fully (up to the cap), as a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Parse a body as JSON; returns null when the body is empty or malformed. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Send a JSON reply with the standard headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Send an already-serialized JSON body (e.g. the cached issue JSON). Skips
 * the stringify and the buffer copy `sendJson` would do per request.
 */
export function sendPrebuiltJson(
  res: ServerResponse,
  status: number,
  body: Buffer,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

/** Send a GitHub-style error body: `{message}`. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Send raw bytes with a content type (git smart HTTP). */
export function sendBytes(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/**
 * Bearer auth. Returns the viewer login when the token matches, 'none' when
 * no token was sent, and 'wrong' when a different token was sent.
 * A startsWith + slice, not a regex: this runs on every authed request.
 */
export function checkAuth(req: IncomingMessage, expectedToken: string, viewerLogin: string): string | 'none' | 'wrong' {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return 'none';
  if (!header.startsWith('Bearer ')) return 'wrong';
  return header.slice(7) === expectedToken ? viewerLogin : 'wrong';
}

/** Require auth on a route; sends 401 and returns null when it fails. */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
  viewerLogin: string,
): string | null {
  const auth = checkAuth(req, expectedToken, viewerLogin);
  if (auth === 'none' || auth === 'wrong') {
    sendError(res, 401, 'Requires authentication');
    return null;
  }
  return auth;
}

/** Split a URL path into decoded segments, dropping empty ones. One pass; a
 * segment is only percent-decoded when it actually contains a '%'. */
export function pathSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const segment of pathname.split('/')) {
    if (segment === '') continue;
    if (segment.includes('%')) {
      try {
        out.push(decodeURIComponent(segment));
      } catch {
        out.push(segment);
      }
    } else {
      out.push(segment);
    }
  }
  return out;
}

/** Parse a query string into a map of first values. A pair is only
 * percent-decoded when it actually contains a '%'; when either side fails
 * to decode, both stay raw, as before. */
export function queryParams(search: string): Map<string, string> {
  const params = new Map<string, string>();
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') return params;
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    const key = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? '' : pair.slice(equals + 1);
    if (!params.has(key)) {
      if (!key.includes('%') && !value.includes('%')) {
        params.set(key, value);
      } else {
        try {
          params.set(decodeURIComponent(key), decodeURIComponent(value));
        } catch {
          params.set(key, value);
        }
      }
    }
  }
  return params;
}
