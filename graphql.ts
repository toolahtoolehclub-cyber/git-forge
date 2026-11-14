// GitHub GraphQL v4: a small hand-written executor for exactly the documents
// gh and github-mcp-server send — viewer and repository reads, issue and pull
// request lists with cursor pagination, the five mutations, Relay node ids,
// and the __type introspection probes. Unknown fields answer HTTP 200 with
// an errors array; an unknown repository answers data.repository null.

import {
  addComment,
  commentGlobalId,
  createIssue,
  createPull,
  decodeGlobalId,
  issueGlobalId,
  mergePull,
  pullFileChanges,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

export interface GqlField {
  kind: 'field';
  alias: string;
  name: string;
  args: Map<string, GqlValue>;
  selections: GqlSelection[];
}

export interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlInlineFragment;

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

class Parser {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (true) {
      this.skipIgnored();
      if (this.pos >= this.text.length) break;
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  private take(expected: string): void {
    this.skipIgnored();
    if (!this.text.startsWith(expected, this.pos)) {
      throw new Error(`expected ${JSON.stringify(expected)} at ${this.pos}`);
    }
    this.pos += expected.length;
  }

  private takeName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new Error(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const word = this.peek();
    if (word === 'q' || word === 'm') {
      const name = this.takeName();
      if (name === 'query') kind = 'query';
      else if (name === 'mutation') kind = 'mutation';
      else throw new Error(`unsupported operation ${name}`);
    }
    let name: string | null = null;
    this.skipIgnored();
    if (/[A-Za-z_]/.test(this.peek())) name = this.takeName();
    if (this.peek() === '(') this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private skipVariableDefinitions(): void {
    this.take('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === '"') this.skipString();
      this.pos += 1;
    }
  }

  private skipString(): void {
    this.pos += 1;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (ch === '"') return;
      this.pos += 1;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.take('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.take('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipIgnored();
      if (this.text.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.text[this.pos + 2] ?? '')) {
        this.pos += 2;
        const typeCondition = this.takeName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      // Named fragment spread: not used by the suite's documents.
      this.takeName();
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: [] };
    }
    const first = this.takeName();
    let alias = first;
    let name = first;
    this.skipIgnored();
    if (this.peek() === ':') {
      this.pos += 1;
      name = this.takeName();
    }
    const args = this.peek() === '(' ? this.parseArguments() : new Map<string, GqlValue>();
    this.skipDirectives();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private skipDirectives(): void {
    for (;;) {
      this.skipIgnored();
      if (this.peek() !== '@') return;
      this.pos += 1;
      this.takeName();
      if (this.peek() === '(') this.skipVariableDefinitions();
    }
  }

  private parseArguments(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    this.take('(');
    while (this.peek() !== ')') {
      const name = this.takeName();
      this.take(':');
      args.set(name, this.parseValue());
    }
    this.take(')');
    return args;
  }

  private parseValue(): GqlValue {
    this.skipIgnored();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.takeName() };
    }
    if (ch === '"') return { kind: 'string', value: this.parseString() };
    if (ch === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.take(']');
      return { kind: 'list', items };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}') {
        const name = this.takeName();
        this.take(':');
        fields.set(name, this.parseValue());
      }
      this.take('}');
      return { kind: 'object', fields };
    }
    // A bare number literal (an integer or float) comes before any name.
    const numMatch = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.pos));
    if (numMatch !== null) {
      this.pos += numMatch[0].length;
      return numMatch[0].includes('.')
        ? { kind: 'float', value: Number(numMatch[0]) }
        : { kind: 'int', value: Number(numMatch[0]) };
    }
    const word = this.takeName();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private parseString(): string {
    this.take('"');
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1] as string;
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
        out += escapes[next] ?? next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }
}

/** Parse one GraphQL document (which may hold several operations). */
export function parseGraphQL(text: string): GqlOperation[] {
  return new Parser(text).parse();
}

// ---------------------------------------------------------------- values

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

function argString(args: Map<string, GqlValue>, name: string, variables: Record<string, unknown>): string | undefined {
  const raw = args.get(name);
  if (raw === undefined) return undefined;
  const value = resolveValue(raw, variables);
  return typeof value === 'string' ? value : undefined;
}

function argInt(args: Map<string, GqlValue>, name: string, variables: Record<string, unknown>): number | undefined {
  const raw = args.get(name);
  if (raw === undefined) return undefined;
  const value = resolveValue(raw, variables);
  return typeof value === 'number' ? value : undefined;
}

function argValue(args: Map<string, GqlValue>, name: string, variables: Record<string, unknown>): unknown {
  const raw = args.get(name);
  return raw === undefined ? undefined : resolveValue(raw, variables);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- executor

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Source =
  | { type: 'Query' }
  | { type: 'User'; login: string }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Ref'; name: string }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: Pull }
  | { type: 'IssueComment'; repo: Repo; commentId: number; body: string }
  | { type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { type: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { type: 'FileConnection'; files: Array<{ path: string }> }
  | { type: 'File'; path: string }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'Type'; name: string; fields: string[]; enumValues: string[] }
  | { type: 'TypeField'; name: string }
  | { type: 'EnumValue'; name: string }
  | { type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { type: 'AddCommentPayload'; repo: Repo; commentId: number; body: string }
  | { type: 'CommentEdge'; repo: Repo; commentId: number; body: string };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'state', 'merged', 'mergedAt', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'TOPIC'];

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function resolveField(source: Source, field: GqlField, ctx: ExecContext): unknown {
  const store = ctx.store;
  switch (source.type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return resolveSelections(field.selections, { type: 'User', login: store.viewerLogin }, ctx);
      }
      if (field.name === 'repository') {
        const owner = argString(field.args, 'owner', ctx.variables);
        const name = argString(field.args, 'name', ctx.variables);
        const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        return resolveSelections(field.selections, { type: 'Repository', repo }, ctx);
      }
      if (field.name === 'node') {
        const id = argString(field.args, 'id', ctx.variables);
        if (id === undefined) return null;
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        const repo = [...store.repos.values()].find((candidate) => candidate.id === decoded.repoId);
        if (repo === undefined) return null;
        if (decoded.kind === 'Repository') {
          return resolveSelections(field.selections, { type: 'Repository', repo }, ctx);
        }
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(decoded.number);
          if (issue === undefined) return null;
          return resolveSelections(field.selections, { type: 'Issue', repo, issue }, ctx);
        }
        if (decoded.kind === 'PullRequest') {
          const pull = repo.pulls.get(decoded.number);
          if (pull === undefined) return null;
          return resolveSelections(field.selections, { type: 'PullRequest', repo, pull }, ctx);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argString(field.args, 'name', ctx.variables);
        if (name === undefined) return null;
        if (name === 'SearchType') {
          return resolveSelections(field.selections, { type: 'Type', name, fields: [], enumValues: SEARCH_TYPE_VALUES }, ctx);
        }
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return resolveSelections(field.selections, { type: 'Type', name, fields, enumValues: [] }, ctx);
      }
      if (field.name === 'createIssue') return resolveCreateIssue(field, ctx);
      if (field.name === 'closeIssue') return resolveCloseIssue(field, ctx);
      if (field.name === 'createPullRequest') return resolveCreatePullRequest(field, ctx);
      if (field.name === 'mergePullRequest') return resolveMergePullRequest(field, ctx);
      if (field.name === 'addComment') return resolveAddComment(field, ctx);
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      return null;
    }
    case 'User': {
      if (field.name === 'login') return source.login;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "User".` });
      return null;
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return resolveSelections(field.selections, { type: 'User', login: repo.owner }, ctx);
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          if (tip === null) return null;
          return resolveSelections(field.selections, { type: 'Ref', name: repo.defaultBranch }, ctx);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const number = argInt(field.args, 'number', ctx.variables);
          const issue = number === undefined ? undefined : repo.issues.get(number);
          if (issue === undefined) return null;
          return resolveSelections(field.selections, { type: 'Issue', repo, issue }, ctx);
        }
        case 'issues': return resolveIssuesConnection(repo, field, ctx);
        case 'pullRequests': return resolvePullRequestsConnection(repo, field, ctx);
        case 'pullRequest': {
          const number = argInt(field.args, 'number', ctx.variables);
          const pull = number === undefined ? undefined : repo.pulls.get(number);
          if (pull === undefined) return null;
          return resolveSelections(field.selections, { type: 'PullRequest', repo, pull }, ctx);
        }
        case 'url': return `/${repo.owner}/${repo.name}`;
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
          return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return source.name;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Ref".` });
      return null;
    }
    case 'Issue': {
      const issue = source.issue;
      switch (field.name) {
        case 'id': return issueGlobalId(source.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueState(issue);
        case 'body': return issue.body;
        case 'url': return `/${source.repo.owner}/${source.repo.name}/issues/${issue.number}`;
        case 'author': return resolveSelections(field.selections, { type: 'User', login: store.viewerLogin }, ctx);
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
          return null;
      }
    }
    case 'PullRequest': {
      const pull = source.pull;
      switch (field.name) {
        case 'id': return pullGlobalId(source.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return pull.baseSha;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(store, source.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const first = argInt(field.args, 'first', ctx.variables) ?? 10;
          const files = pullFileChanges(store, source.repo, pull)
            .slice(0, first)
            .map((change) => ({ path: change.path }));
          return resolveSelections(field.selections, { type: 'FileConnection', files }, ctx);
        }
        case 'url': return `/${source.repo.owner}/${source.repo.name}/pull/${pull.number}`;
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return source.issues.map((issue) => resolveSelections(field.selections, { type: 'Issue', repo: source.repo, issue }, ctx));
      }
      if (field.name === 'pageInfo') {
        return resolveSelections(field.selections, { type: 'PageInfo', hasNextPage: source.pageInfo.hasNextPage, endCursor: source.pageInfo.endCursor }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "IssueConnection".` });
      return null;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return source.pulls.map((pull) => resolveSelections(field.selections, { type: 'PullRequest', repo: source.repo, pull }, ctx));
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequestConnection".` });
      return null;
    }
    case 'FileConnection': {
      if (field.name === 'nodes') {
        return source.files.map((file) => resolveSelections(field.selections, { type: 'File', path: file.path }, ctx));
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequestFileConnection".` });
      return null;
    }
    case 'File': {
      if (field.name === 'path') return source.path;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequestFile".` });
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return source.hasNextPage;
      if (field.name === 'endCursor') return source.endCursor;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PageInfo".` });
      return null;
    }
    case 'Type': {
      if (field.name === 'name') return source.name;
      if (field.name === 'fields') {
        return source.fields.map((name) => resolveSelections(field.selections, { type: 'TypeField', name }, ctx));
      }
      if (field.name === 'enumValues') {
        return source.enumValues.map((name) => resolveSelections(field.selections, { type: 'EnumValue', name }, ctx));
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "__Type".` });
      return null;
    }
    case 'TypeField':
    case 'EnumValue': {
      if (field.name === 'name') return source.name;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "__Field".` });
      return null;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') {
        return resolveSelections(field.selections, { type: 'Issue', repo: source.repo, issue: source.issue }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "CreateIssuePayload".` });
      return null;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        return resolveSelections(field.selections, { type: 'Issue', repo: source.repo, issue: source.issue }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "CloseIssuePayload".` });
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') {
        return resolveSelections(field.selections, { type: 'PullRequest', repo: source.repo, pull: source.pull }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "CreatePullRequestPayload".` });
      return null;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        return resolveSelections(field.selections, { type: 'PullRequest', repo: source.repo, pull: source.pull }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "MergePullRequestPayload".` });
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        return resolveSelections(field.selections, { type: 'CommentEdge', repo: source.repo, commentId: source.commentId, body: source.body }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "AddCommentPayload".` });
      return null;
    }
    case 'CommentEdge': {
      if (field.name === 'node') {
        return resolveSelections(field.selections, { type: 'IssueComment', repo: source.repo, commentId: source.commentId, body: source.body }, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "IssueCommentEdge".` });
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return commentGlobalId(source.repo, { id: source.commentId, body: source.body, createdSeq: 0 });
      if (field.name === 'body') return source.body;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "IssueComment".` });
      return null;
    }
  }
}

function resolveSelections(selections: GqlSelection[], source: Source, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== source.type) continue;
      // Inline fragments on Repository use the GraphQL type name, not the internal one.
      if (selection.typeCondition === 'Repository' && source.type !== 'Repository') continue;
      const nested = resolveSelections(selection.selections, source, ctx);
      Object.assign(out, nested);
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = source.type;
      continue;
    }
    out[selection.alias] = resolveField(source, selection, ctx);
  }
  return out;
}

function resolveIssuesConnection(repo: Repo, field: GqlField, ctx: ExecContext): Record<string, unknown> {
  const first = argInt(field.args, 'first', ctx.variables) ?? 10;
  const after = argString(field.args, 'after', ctx.variables);
  const states = argValue(field.args, 'states', ctx.variables);
  const orderBy = argValue(field.args, 'orderBy', ctx.variables);
  let issues = [...repo.issues.values()];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const record = orderBy as Record<string, unknown>;
    if (typeof record.direction === 'string') direction = record.direction;
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const cursor = numberFromCursor(after);
  if (cursor !== null) {
    issues = issues.filter((issue) => (direction === 'DESC' ? issue.number < cursor : issue.number > cursor));
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]?.number ?? 0);
  return resolveSelections(field.selections, {
    type: 'IssueConnection',
    repo,
    issues: page,
    pageInfo: { hasNextPage, endCursor },
  }, ctx);
}

function resolvePullRequestsConnection(repo: Repo, field: GqlField, ctx: ExecContext): Record<string, unknown> {
  const first = argInt(field.args, 'first', ctx.variables) ?? 10;
  const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
  return resolveSelections(field.selections, { type: 'PullRequestConnection', repo, pulls }, ctx);
}

function findRepoByGlobalId(store: Store, id: string | undefined): Repo | null {
  if (id === undefined) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return [...store.repos.values()].find((repo) => repo.id === decoded.repoId) ?? null;
}

function findIssueByGlobalId(store: Store, id: string | undefined): { repo: Repo; issue: Issue } | null {
  if (id === undefined) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === decoded.repoId);
  if (repo === undefined) return null;
  const issue = repo.issues.get(decoded.number);
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, id: string | undefined): { repo: Repo; pull: Pull } | null {
  if (id === undefined) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === decoded.repoId);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(decoded.number);
  return pull === undefined ? null : { repo, pull };
}

function resolveCreateIssue(field: GqlField, ctx: ExecContext): Record<string, unknown> | null {
  const input = argValue(field.args, 'input', ctx.variables);
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'createIssue needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const repo = findRepoByGlobalId(ctx.store, typeof record.repositoryId === 'string' ? record.repositoryId : undefined);
  if (repo === null) {
    ctx.errors.push({ message: 'createIssue: repository not found.' });
    return null;
  }
  const title = typeof record.title === 'string' ? record.title : '';
  const body = typeof record.body === 'string' ? record.body : '';
  const issue = createIssue(ctx.store, repo, title, body, []);
  return resolveSelections(field.selections, { type: 'CreateIssuePayload', repo, issue }, ctx);
}

function resolveCloseIssue(field: GqlField, ctx: ExecContext): Record<string, unknown> | null {
  const input = argValue(field.args, 'input', ctx.variables);
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'closeIssue needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const found = findIssueByGlobalId(ctx.store, typeof record.issueId === 'string' ? record.issueId : undefined);
  if (found === null) {
    ctx.errors.push({ message: 'closeIssue: issue not found.' });
    return null;
  }
  found.issue.state = 'closed';
  return resolveSelections(field.selections, { type: 'CloseIssuePayload', repo: found.repo, issue: found.issue }, ctx);
}

function resolveCreatePullRequest(field: GqlField, ctx: ExecContext): Record<string, unknown> | null {
  const input = argValue(field.args, 'input', ctx.variables);
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'createPullRequest needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const repo = findRepoByGlobalId(ctx.store, typeof record.repositoryId === 'string' ? record.repositoryId : undefined);
  if (repo === null) {
    ctx.errors.push({ message: 'createPullRequest: repository not found.' });
    return null;
  }
  const headRef = typeof record.headRefName === 'string' ? record.headRefName : '';
  const baseRef = typeof record.baseRefName === 'string' ? record.baseRefName : '';
  const headSha = ctx.store.branchTip(repo, headRef);
  const baseSha = ctx.store.branchTip(repo, baseRef);
  if (headSha === null || baseSha === null) {
    ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
    return null;
  }
  const title = typeof record.title === 'string' ? record.title : '';
  const body = typeof record.body === 'string' ? record.body : '';
  const pull = createPull(ctx.store, repo, title, body, headRef, baseRef, headSha, baseSha);
  return resolveSelections(field.selections, { type: 'CreatePullRequestPayload', repo, pull }, ctx);
}

function resolveMergePullRequest(field: GqlField, ctx: ExecContext): Record<string, unknown> | null {
  const input = argValue(field.args, 'input', ctx.variables);
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'mergePullRequest needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const found = findPullByGlobalId(ctx.store, typeof record.pullRequestId === 'string' ? record.pullRequestId : undefined);
  if (found === null) {
    ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
    return null;
  }
  const outcome = mergePull(ctx.store, found.repo, found.pull);
  if (!outcome.ok) {
    ctx.errors.push({ message: outcome.conflict ? 'merge conflict' : outcome.message });
    return null;
  }
  return resolveSelections(field.selections, { type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull }, ctx);
}

function resolveAddComment(field: GqlField, ctx: ExecContext): Record<string, unknown> | null {
  const input = argValue(field.args, 'input', ctx.variables);
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'addComment needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const found = findIssueByGlobalId(ctx.store, typeof record.subjectId === 'string' ? record.subjectId : undefined);
  if (found === null) {
    ctx.errors.push({ message: 'addComment: subject not found.' });
    return null;
  }
  const body = typeof record.body === 'string' ? record.body : '';
  const comment = addComment(ctx.store, found.issue, body);
  return resolveSelections(field.selections, { type: 'AddCommentPayload', repo: found.repo, commentId: comment.id, body }, ctx);
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL document against the store. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  let operations: GqlOperation[];
  try {
    operations = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  if (operations.length === 0) return { data: {} };
  const operation = operations[0] as GqlOperation;
  const ctx: ExecContext = { store, variables, errors: [] };
  const data = resolveSelections(operation.selections, { type: 'Query' }, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Execute a request body that may hold one document or an array of them. */
export function executeGraphQLBody(
  store: Store,
  body: unknown,
): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => {
      if (item === null || typeof item !== 'object') return { data: null, errors: [{ message: 'bad request' }] };
      const record = item as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables !== null && typeof record.variables === 'object'
        ? record.variables
        : {}) as Record<string, unknown>;
      return executeGraphQL(store, query, variables);
    });
  }
  if (body === null || typeof body !== 'object') return { data: null, errors: [{ message: 'bad request' }] };
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables !== null && typeof record.variables === 'object'
    ? record.variables
    : {}) as Record<string, unknown>;
  return executeGraphQL(store, query, variables);
}
