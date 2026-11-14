// The forge's whole state: one in-memory store shared by git smart HTTP, REST,
// GraphQL and MCP, so a repo created through one surface is the same object
// through every other. Everything is deterministic: ids and sequences come
// from counters, commit epochs from a fixed base plus a counter — no wall
// clock, no randomness, so two runs on one instance agree.

import {
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  hashObject,
  identityLine,
  isAncestor,
  lineCount,
  mergeBase,
  parseCommit,
  parseTree,
  threeWayMerge,
  type GitObject,
  type ObjType,
  type ObjectStore,
} from './git.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
}

export const COMMIT_EPOCH_BASE = 1735689600;

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unbase64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/** Opaque, stable Relay ids: never the plain database id or number. */
export function repoGlobalId(repo: Repo): string {
  return base64url(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return base64url(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return base64url(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, comment: Comment): string {
  return base64url(`IssueComment:${repo.id}:${comment.id}`);
}

export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

export function decodeGlobalId(id: string): { kind: GlobalIdKind; repoId: number; number: number } | null {
  let text: string;
  try {
    text = unbase64url(id);
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0] as GlobalIdKind;
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') {
    return null;
  }
  const repoId = Number(parts[1]);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
  const number = parts.length >= 3 ? Number(parts[2]) : 0;
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return { kind, repoId, number };
}

export class Store {
  readonly viewerLogin: string;
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private seq = 1;
  private commitCounter = 0;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  /** Next creation sequence (ordering + deterministic commit epochs). */
  nextSeq(): number {
    return this.seq++;
  }

  nextRestId(): number {
    return this.nextId++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRestId(),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposForOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  objectStoreOf(repo: Repo): ObjectStore {
    return { get: (oid: string) => repo.objects.get(oid) };
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The viewer identity used for commits the forge creates itself. */
  identity(): { name: string; email: string; epoch: number } {
    this.commitCounter += 1;
    return {
      name: this.viewerLogin,
      email: `${this.viewerLogin}@example.invalid`,
      epoch: COMMIT_EPOCH_BASE + this.commitCounter,
    };
  }

  /** Build a tree object from a flat path -> blob map, storing every subtree. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, string>): string {
    const build = (paths: Map<string, string>, prefix: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const children = new Map<string, Map<string, string>>();
      for (const [path, oid] of paths) {
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          const dir = rest.slice(0, slash);
          let child = children.get(dir);
          if (child === undefined) {
            child = new Map();
            children.set(dir, child);
          }
          child.set(path, oid);
        }
      }
      for (const [dir, child] of children) {
        entries.push({ mode: '40000', name: dir, oid: build(child, prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(flat, '');
  }

  /** Resolve a ref name, tag or raw sha to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object === undefined) return null;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') {
        // Peel an annotated tag to its commit.
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        return match ? match[1] as string : null;
      }
      return null;
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return this.peelToCommit(repo, direct);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return this.peelToCommit(repo, branch);
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return this.peelToCommit(repo, tag);
    return null;
  }

  peelToCommit(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match === null) return null;
      return this.peelToCommit(repo, match[1] as string);
    }
    return null;
  }

  /** The commit oid a branch ref points at, or null when unborn/missing. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    return this.peelToCommit(repo, oid);
  }
}

// ---------------------------------------------------------------- issues, pulls, labels

export function createIssue(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): Issue {
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: store.nextRestId(),
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdSeq: store.nextSeq(),
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPull(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
  headSha: string,
  baseSha: string,
): Pull {
  const number = repo.nextNumber++;
  const pull: Pull = {
    id: store.nextRestId(),
    number,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
  };
  repo.pulls.set(number, pull);
  return pull;
}

export function addComment(store: Store, issue: Issue, body: string): Comment {
  const comment: Comment = { id: store.nextRestId(), body, createdSeq: store.nextSeq() };
  issue.comments.push(comment);
  return comment;
}

/** The flat file tree at a commit, or null when the commit is unknown. */
export function treeAtCommit(store: Store, repo: Repo, commitOid: string): Map<string, string> | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  const tree = parseCommit(object.data).tree;
  return flattenTree(store.objectStoreOf(repo), tree);
}

export interface MergeOutcome {
  ok: boolean;
  conflict: boolean;
  sha: string | null;
  message: string;
}

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree
 * is the three-way merge of base and head against their merge-base. A
 * conflict on any path refuses the merge with no state change.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull, message?: string): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, conflict: false, sha: null, message: 'pull request is not open' };
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) {
    return { ok: false, conflict: false, sha: null, message: 'head or base branch is missing' };
  }
  const objectStore = store.objectStoreOf(repo);
  const base = mergeBase(objectStore, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, string>() : treeAtCommit(store, repo, base) ?? new Map<string, string>();
  const oursFlat = treeAtCommit(store, repo, baseTip) ?? new Map<string, string>();
  const theirsFlat = treeAtCommit(store, repo, headTip) ?? new Map<string, string>();
  const merged = threeWayMerge(baseFlat, oursFlat, theirsFlat);
  if (merged.conflict) {
    return { ok: false, conflict: true, sha: null, message: 'merge conflict' };
  }
  const tree = store.buildTreeFromFlat(repo, merged.tree);
  const identity = store.identity();
  const line = identityLine(identity);
  const commitMessage = message ?? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commit = store.putObject(
    repo,
    'commit',
    buildCommit({ tree, parents: [baseTip], author: line, committer: line, message: commitMessage }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commit;
  pull.mergedAt = new Date(identity.epoch * 1000).toISOString();
  return { ok: true, conflict: false, sha: commit, message: 'merged' };
}

/** Whether a pull request would merge cleanly right now (no state change). */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return false;
  const objectStore = store.objectStoreOf(repo);
  const base = mergeBase(objectStore, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, string>() : treeAtCommit(store, repo, base) ?? new Map<string, string>();
  const oursFlat = treeAtCommit(store, repo, baseTip) ?? new Map<string, string>();
  const theirsFlat = treeAtCommit(store, repo, headTip) ?? new Map<string, string>();
  return !threeWayMerge(baseFlat, oursFlat, theirsFlat).conflict;
}

// ---------------------------------------------------------------- contents

export interface ContentsWrite {
  commitSha: string;
  blobSha: string;
  created: boolean;
}

/**
 * Write one file through the contents surface: a new blob, a new tree, a new
 * commit on `branch` (created when the branch is unborn). Returns the commit
 * and blob ids, and whether the path was new.
 */
export function writeContents(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): ContentsWrite {
  const blobSha = store.putObject(repo, 'blob', content);
  const tip = store.branchTip(repo, branch);
  const flat = tip === null ? new Map<string, string>() : treeAtCommit(store, repo, tip) ?? new Map<string, string>();
  const created = !flat.has(path);
  flat.set(path, blobSha);
  const tree = store.buildTreeFromFlat(repo, flat);
  const identity = store.identity();
  const line = identityLine(identity);
  const commit = store.putObject(
    repo,
    'commit',
    buildCommit({
      tree,
      parents: tip === null ? [] : [tip],
      author: line,
      committer: line,
      message,
    }),
  );
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { commitSha: commit, blobSha, created };
}

/** Delete one file through the contents surface: a new commit without it. */
export function deleteContents(store: Store, repo: Repo, branch: string, path: string, message: string): string | null {
  const tip = store.branchTip(repo, branch);
  if (tip === null) return null;
  const flat = treeAtCommit(store, repo, tip);
  if (flat === null || !flat.has(path)) return null;
  flat.delete(path);
  const tree = store.buildTreeFromFlat(repo, flat);
  const identity = store.identity();
  const line = identityLine(identity);
  const commit = store.putObject(
    repo,
    'commit',
    buildCommit({ tree, parents: [tip], author: line, committer: line, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

// ---------------------------------------------------------------- serializers

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined
        ? { name, color: '000000', description: '' }
        : labelJson(label);
    }),
    user: { login: store.viewerLogin, type: 'User' },
    comments: issue.comments.length,
  };
}

export function commentJson(store: Store, repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, comment),
    body: comment.body,
    user: { login: store.viewerLogin, type: 'User' },
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: store.viewerLogin, type: 'User' },
  };
}

export function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: '' }, protected: false };
}

export function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parts = parseCommit(object.data);
  const authorLine = parts.author;
  const date = authorDate(authorLine);
  const parents = parts.parents.map((parent) => ({ sha: parent }));
  return {
    sha,
    node_id: base64url(`Commit:${repo.id}:${sha}`),
    commit: {
      message: parts.message,
      author: { name: authorName(authorLine), email: authorEmail(authorLine), date },
      committer: { name: authorName(parts.committer), email: authorEmail(parts.committer), date },
      tree: { sha: parts.tree },
    },
    parents,
  };
}

function authorName(line: string): string {
  const match = /^(.*) <[^>]*>/.exec(line);
  return match ? (match[1] as string) : '';
}

function authorEmail(line: string): string {
  const match = /<([^>]*)>/.exec(line);
  return match ? (match[1] as string) : '';
}

function authorDate(line: string): string {
  const match = /> (\d+) /.exec(line);
  if (match === null) return new Date(COMMIT_EPOCH_BASE * 1000).toISOString();
  return new Date(Number(match[1]) * 1000).toISOString();
}

/** The file entries of a tree at one path (for directory contents reads). */
export function directoryEntries(
  store: Store,
  repo: Repo,
  treeOid: string,
  prefix: string,
): Array<Record<string, unknown>> | null {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return null;
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- pull request files

export interface PullFileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The files a pull request changes, diffed against its merge-base. */
export function pullFileChanges(store: Store, repo: Repo, pull: Pull): PullFileChange[] {
  const objectStore = store.objectStoreOf(repo);
  const base = mergeBase(objectStore, pull.baseSha, pull.headSha);
  const baseFlat = base === null ? new Map<string, string>() : treeAtCommit(store, repo, base) ?? new Map<string, string>();
  const headFlat = treeAtCommit(store, repo, pull.headSha) ?? new Map<string, string>();
  const out: PullFileChange[] = [];
  for (const change of diffTrees(baseFlat, headFlat)) {
    const newBlob = change.newOid === undefined ? undefined : repo.objects.get(change.newOid);
    const oldBlob = change.oldOid === undefined ? undefined : repo.objects.get(change.oldOid);
    let additions = 0;
    let deletions = 0;
    if (change.status === 'added') {
      additions = Math.max(1, lineCount(newBlob?.data ?? Buffer.alloc(0)));
    } else if (change.status === 'removed') {
      deletions = Math.max(1, lineCount(oldBlob?.data ?? Buffer.alloc(0)));
    } else {
      additions = Math.max(1, lineDifference(newBlob?.data ?? Buffer.alloc(0), oldBlob?.data ?? Buffer.alloc(0)));
      deletions = lineDifference(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
    }
    out.push({
      path: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    });
  }
  return out;
}

/** Lines in `a` that are not in `b`, counting duplicates (multiset difference). */
function lineDifference(a: Buffer, b: Buffer): number {
  const aLines = a.length === 0 ? [] : a.toString('utf8').split('\n');
  const bLines = b.length === 0 ? [] : b.toString('utf8').split('\n');
  const counts = new Map<string, number>();
  for (const line of bLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let diff = 0;
  for (const line of aLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else diff += 1;
  }
  return diff;
}
