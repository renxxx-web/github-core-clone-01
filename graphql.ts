// A small GraphQL engine for the forge: lexer, parser (operations, variables, aliases, fragments,
// directives), and an executor over the same store the REST and git surfaces use. It implements
// the slice of the GitHub v4 schema the conformance world exercises, including introspection of
// the types it defines and opaque global ids that round-trip through node() and the mutations.

import {
  VIEWER,
  diffFlats,
  globalId,
  isoNow,
  parseGlobalId,
  threeWayMerge,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push({ kind: 'string', value });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: 'name', value: (match as RegExpExecArray)[0] });
      i += (match as RegExpExecArray)[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

interface ValueNode {
  kind: 'variable' | 'string' | 'number' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  items?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}

interface FieldNode {
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  directives: { name: string; args: { name: string; value: ValueNode }[] }[];
  selection?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  varDefs: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(source: string) {
    this.tokens = lex(source);
  }
  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', varDefs: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        const varDefs = this.atPunct('(') ? this.parseVarDefs() : [];
        this.parseDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, varDefs, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): { name: string; defaultValue?: ValueNode }[] {
    const defs: { name: string; defaultValue?: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      let defaultValue: ValueNode | undefined;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.parseDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseTypeRef(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): { name: string; args: { name: string; value: ValueNode }[] }[] {
    const directives: { name: string; args: { name: string; value: ValueNode }[] }[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArgs() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArgs(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', value: this.expectName() };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'number') {
      this.next();
      return { kind: 'number', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
          const name = this.expectName();
          this.parseDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          let typeCondition: string | undefined;
          if (this.peek().kind === 'name') {
            this.expectName(); // 'on'
            typeCondition = this.expectName();
          }
          const directives = this.parseDirectives();
          void directives;
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = this.atPunct('(') ? this.parseArgs() : [];
      const directives = this.parseDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', field: { name, alias, args, directives, selection } });
    }
    this.expectPunct('}');
    return selections;
  }
}

// ---------------------------------------------------------------------------------------------
// schema description for introspection

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived',
    'defaultBranchRef', 'viewerPermission', 'viewerCanAdminister', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'hasWikiEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'author', 'committer', 'tree'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'viewerCanUpdate',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'repository', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'isDraft', 'viewerCanUpdate',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  GitActor: ['name', 'email', 'date'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------------------------
// execution

interface Ctx {
  forge: Forge;
  base: string;
}

type Wrapped = { __type: string; [key: string]: unknown };

function wrap(type: string, fields: Record<string, unknown>): Wrapped {
  return { __type: type, ...fields };
}

function repoWrap(ctx: Ctx, repo: Repo): Wrapped {
  return wrap('Repository', { repo });
}

function viewerWrap(): Wrapped {
  return wrap('User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
}

function issueWrap(repo: Repo, issue: Issue): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullWrap(repo: Repo, pull: Pull): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

function commentWrap(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): Wrapped {
  return wrap('IssueComment', { repo, issue, comment });
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexFromCursor(cursor: string | undefined): number {
  if (cursor === undefined) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

interface Connection {
  wrappedItems: Wrapped[];
  totalCount: number;
}

function paginate(items: Wrapped[], args: Record<string, unknown>): Wrapped {
  const first = typeof args.first === 'number' ? args.first : 100;
  const start = indexFromCursor(typeof args.after === 'string' ? args.after : undefined) + 1;
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  const pageInfo = wrap('PageInfo', {
    hasNextPage: hasNext,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? cursorFor(start) : null,
    endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
  });
  const connectionType = slice[0]?.__type === 'Issue' ? 'IssueConnection'
    : slice[0]?.__type === 'PullRequest' ? 'PullRequestConnection'
    : slice[0]?.__type === 'IssueComment' ? 'IssueCommentConnection'
    : slice[0]?.__type === 'Label' ? 'LabelConnection'
    : 'PullRequestFileConnection';
  const edgeType = connectionType.replace('Connection', 'Edge');
  return wrap(connectionType, {
    nodes: slice,
    edges: slice.map((node, i) => wrap(edgeType, { node, cursor: cursorFor(start + i) })),
    pageInfo,
    totalCount: items.length,
  });
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.value as string];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = repo.mergeBase(headTip, baseTip);
  const ancestorTree = base === undefined ? undefined : repo.commitView(base)?.tree;
  const headTree = repo.commitView(headTip)?.tree;
  const baseTree = repo.commitView(baseTip)?.tree;
  if (headTree === undefined || baseTree === undefined) return 'UNKNOWN';
  return threeWayMerge(repo, ancestorTree, headTree, baseTree).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// Shared domain operations (also used by the mutations) — kept here so GraphQL writes land in the
// same store the REST surface reads.

export function gqlCreateIssue(forge: Forge, repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: isoNow(),
    updatedAt: isoNow(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.touch();
  return issue;
}

export function gqlCreatePull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
  if (repo.branchTip(headRef) === undefined || repo.branchTip(baseRef) === undefined) return null;
  const pull: Pull = {
    id: 0,
    number: repo.nextNumber,
    title,
    body,
    headRef,
    baseRef,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  };
  pull.id = pull.number; // per-repo uniqueness is enough for the payloads in play
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  repo.touch();
  return pull;
}

/** Squash-merge a pull request; returns 'merged' | 'conflict' | 'not-open'. */
export function gqlMergePull(repo: Repo, pull: Pull): 'merged' | 'conflict' | 'not-open' {
  if (pull.state !== 'open' || pull.merged) return 'not-open';
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'conflict';
  const base = repo.mergeBase(headTip, baseTip);
  const ancestorTree = base === undefined ? undefined : repo.commitView(base)?.tree;
  const headTree = repo.commitView(headTip)?.tree;
  const baseTree = repo.commitView(baseTip)?.tree;
  if (headTree === undefined || baseTree === undefined) return 'conflict';
  const outcome = threeWayMerge(repo, ancestorTree, headTree, baseTree);
  if (outcome.conflict || outcome.tree === undefined) return 'conflict';
  const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
  const commit = repo.createCommit({ tree: outcome.tree, parents: [baseTip], message });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  repo.invalidateHistoryCaches();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = commit;
  pull.updatedAt = isoNow();
  repo.touch();
  return 'merged';
}

const repoFields: Record<string, (ctx: Ctx, source: Wrapped, args: Record<string, unknown>) => unknown> = {
  id: (_ctx, source) => globalId('Repository', String((source.repo as Repo).id)),
  databaseId: (_ctx, source) => (source.repo as Repo).id,
  name: (_ctx, source) => (source.repo as Repo).name,
  nameWithOwner: (_ctx, source) => (source.repo as Repo).fullName,
  owner: () => viewerWrap(),
  description: (_ctx, source) => (source.repo as Repo).description,
  isPrivate: (_ctx, source) => (source.repo as Repo).isPrivate,
  isFork: () => false,
  isArchived: () => false,
  defaultBranchRef: (_ctx, source) => {
    const repo = source.repo as Repo;
    const tip = repo.refs.get(repo.headRef);
    if (tip === undefined) return null;
    return wrap('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', target: wrap('Commit', { oid: tip }) });
  },
  viewerPermission: () => 'ADMIN',
  viewerCanAdminister: () => true,
  hasIssuesEnabled: () => true,
  hasPullRequestsEnabled: () => true,
  hasWikiEnabled: () => false,
  url: (ctx, source) => `${ctx.base}/${(source.repo as Repo).fullName}`,
  createdAt: (_ctx, source) => (source.repo as Repo).createdAt,
  updatedAt: (_ctx, source) => (source.repo as Repo).updatedAt,
  issue: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const issue = repo.issues.get(Number(args.number));
    return issue === undefined ? null : issueWrap(repo, issue);
  },
  issues: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    let list = [...repo.issues.values()];
    if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
    const direction = (args.orderBy as { direction?: string } | undefined)?.direction ?? 'DESC';
    list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    return paginate(list.map((issue) => issueWrap(repo, issue)), args);
  },
  pullRequest: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const pull = repo.pulls.get(Number(args.number));
    return pull === undefined ? null : pullWrap(repo, pull);
  },
  pullRequests: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
    let list = [...repo.pulls.values()];
    list = list.filter((pull) => states.includes(pullState(pull)));
    list.sort((a, b) => b.number - a.number);
    return paginate(list.map((pull) => pullWrap(repo, pull)), args);
  },
  labels: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const items = [...repo.labels.values()].map((label) => wrap('Label', { name: label.name, color: label.color, repo }));
    return paginate(items, args);
  },
};

const issueFields: Record<string, (ctx: Ctx, source: Wrapped, args: Record<string, unknown>) => unknown> = {
  id: (_ctx, source) => globalId('Issue', `${(source.repo as Repo).id}:${(source.issue as Issue).number}`),
  databaseId: (_ctx, source) => (source.issue as Issue).id,
  number: (_ctx, source) => (source.issue as Issue).number,
  title: (_ctx, source) => (source.issue as Issue).title,
  body: (_ctx, source) => (source.issue as Issue).body,
  state: (_ctx, source) => (source.issue as Issue).state.toUpperCase(),
  author: () => viewerWrap(),
  repository: (ctx, source) => repoWrap(ctx, source.repo as Repo),
  labels: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    const items = issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => wrap('Label', { name: (label as { name: string }).name, color: (label as { color: string }).color, repo }));
    return paginate(items, args);
  },
  comments: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    return paginate(issue.comments.map((comment) => commentWrap(repo, issue, comment)), args);
  },
  createdAt: (_ctx, source) => (source.issue as Issue).createdAt,
  updatedAt: (_ctx, source) => (source.issue as Issue).updatedAt,
  closedAt: (_ctx, source) => ((source.issue as Issue).state === 'closed' ? (source.issue as Issue).updatedAt : null),
  url: (ctx, source) => `${ctx.base}/${(source.repo as Repo).fullName}/issues/${(source.issue as Issue).number}`,
  viewerCanUpdate: () => true,
};

const pullFields: Record<string, (ctx: Ctx, source: Wrapped, args: Record<string, unknown>) => unknown> = {
  id: (_ctx, source) => globalId('PullRequest', `${(source.repo as Repo).id}:${(source.pull as Pull).number}`),
  databaseId: (_ctx, source) => (source.pull as Pull).id,
  number: (_ctx, source) => (source.pull as Pull).number,
  title: (_ctx, source) => (source.pull as Pull).title,
  body: (_ctx, source) => (source.pull as Pull).body,
  state: (_ctx, source) => pullState(source.pull as Pull),
  author: () => viewerWrap(),
  repository: (ctx, source) => repoWrap(ctx, source.repo as Repo),
  headRefName: (_ctx, source) => (source.pull as Pull).headRef,
  baseRefName: (_ctx, source) => (source.pull as Pull).baseRef,
  headRefOid: (_ctx, source) => (source.repo as Repo).branchTip((source.pull as Pull).headRef) ?? null,
  baseRefOid: (_ctx, source) => (source.repo as Repo).branchTip((source.pull as Pull).baseRef) ?? null,
  mergeable: (_ctx, source) => pullMergeable(source.repo as Repo, source.pull as Pull),
  merged: (_ctx, source) => (source.pull as Pull).merged,
  mergedAt: (_ctx, source) => (source.pull as Pull).mergedAt,
  mergeCommit: (_ctx, source) => {
    const sha = (source.pull as Pull).mergeCommitSha;
    return sha === null ? null : wrap('Commit', { oid: sha });
  },
  files: (_ctx, source, args) => {
    const repo = source.repo as Repo;
    const pull = source.pull as Pull;
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return paginate([], args);
    const base = repo.mergeBase(headTip, baseTip);
    const beforeFlat = base === undefined ? new Map() : repo.flatOfCommit(base);
    const files = diffFlats(repo, beforeFlat, repo.flatOfCommit(headTip));
    const items = files.map((file) =>
      wrap('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
    );
    return paginate(items, args);
  },
  labels: (_ctx, source, args) => paginate([], args),
  comments: (_ctx, source, args) => paginate([], args),
  createdAt: (_ctx, source) => (source.pull as Pull).createdAt,
  updatedAt: (_ctx, source) => (source.pull as Pull).updatedAt,
  closedAt: (_ctx, source) => ((source.pull as Pull).state === 'closed' ? (source.pull as Pull).updatedAt : null),
  url: (ctx, source) => `${ctx.base}/${(source.repo as Repo).fullName}/pull/${(source.pull as Pull).number}`,
  isDraft: () => false,
  viewerCanUpdate: () => true,
};

function nodeByGlobalId(ctx: Ctx, id: string): Wrapped | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'User') return viewerWrap();
  if (parsed.type === 'Repository') {
    const repo = ctx.forge.findRepoById(Number(parsed.key));
    return repo === undefined ? null : repoWrap(ctx, repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':').map(Number);
    const repo = ctx.forge.findRepoById(repoId);
    if (repo === undefined) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueWrap(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullWrap(repo, pull);
  }
  if (parsed.type === 'IssueComment') {
    const [repoId, issueNumber, commentId] = parsed.key.split(':').map(Number);
    const repo = ctx.forge.findRepoById(repoId);
    const issue = repo?.issues.get(issueNumber);
    const comment = issue?.comments.find((entry) => entry.id === commentId);
    if (repo === undefined || issue === undefined || comment === undefined) return null;
    return commentWrap(repo, issue, comment);
  }
  return null;
}

function typeWrap(name: string): Wrapped {
  const isEnum = name in ENUM_VALUES;
  return wrap('__Type', {
    name,
    kind: isEnum ? 'ENUM' : 'OBJECT',
    fields: (TYPE_FIELDS[name] ?? []).map((fieldName) => wrap('__Field', { name: fieldName })),
    enumValues: (ENUM_VALUES[name] ?? []).map((valueName) => wrap('__EnumValue', { name: valueName })),
  });
}

const FIELD_RESOLVERS: Record<string, Record<string, (ctx: Ctx, source: Wrapped, args: Record<string, unknown>) => unknown>> = {
  Repository: repoFields,
  Issue: issueFields,
  PullRequest: pullFields,
  User: {
    id: () => globalId('User', String(VIEWER.id)),
    databaseId: () => VIEWER.id,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    avatarUrl: () => '',
    url: (ctx) => `${ctx.base}/${VIEWER.login}`,
    isViewer: () => true,
  },
  Ref: {
    id: (_ctx, source) => globalId('Ref', `${source.prefix as string}${source.name as string}`),
    name: (_ctx, source) => source.name,
    prefix: (_ctx, source) => source.prefix,
    target: (_ctx, source) => source.target,
  },
  Commit: {
    id: (_ctx, source) => globalId('Commit', source.oid as string),
    oid: (_ctx, source) => source.oid,
  },
  IssueComment: {
    id: (_ctx, source) =>
      globalId('IssueComment', `${(source.repo as Repo).id}:${(source.issue as Issue).number}:${(source.comment as { id: number }).id}`),
    databaseId: (_ctx, source) => (source.comment as { id: number }).id,
    body: (_ctx, source) => (source.comment as { body: string }).body,
    author: () => viewerWrap(),
    createdAt: (_ctx, source) => (source.comment as { createdAt: string }).createdAt,
    updatedAt: (_ctx, source) => (source.comment as { createdAt: string }).createdAt,
    url: (ctx, source) =>
      `${ctx.base}/${(source.repo as Repo).fullName}/issues/${(source.issue as Issue).number}#issuecomment-${(source.comment as { id: number }).id}`,
  },
  Label: {
    id: (_ctx, source) => globalId('Label', `${(source.repo as Repo).id}:${source.name as string}`),
    name: (_ctx, source) => source.name,
    color: (_ctx, source) => source.color,
    description: () => null,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => source.hasNextPage,
    hasPreviousPage: (_ctx, source) => source.hasPreviousPage,
    startCursor: (_ctx, source) => source.startCursor,
    endCursor: (_ctx, source) => source.endCursor,
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => source.path,
    additions: (_ctx, source) => source.additions,
    deletions: (_ctx, source) => source.deletions,
    changeType: (_ctx, source) => source.changeType,
  },
  __Type: {
    name: (_ctx, source) => source.name,
    kind: (_ctx, source) => source.kind,
    description: () => null,
    fields: (_ctx, source) => source.fields,
    enumValues: (_ctx, source) => source.enumValues,
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (_ctx, source) => source.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, source) => source.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: () => typeWrap('Query'),
    mutationType: () => typeWrap('Mutation'),
    subscriptionType: () => null,
    types: () => [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeWrap(name)),
    directives: () => [],
  },
};

// Connection wrappers expose nodes/edges/pageInfo/totalCount generically.
for (const type of ['IssueConnection', 'PullRequestConnection', 'IssueCommentConnection', 'LabelConnection', 'PullRequestFileConnection']) {
  FIELD_RESOLVERS[type] = {
    nodes: (_ctx, source) => source.nodes,
    edges: (_ctx, source) => source.edges,
    pageInfo: (_ctx, source) => source.pageInfo,
    totalCount: (_ctx, source) => source.totalCount,
  };
}
for (const type of ['IssueEdge', 'PullRequestEdge', 'IssueCommentEdge', 'LabelEdge', 'PullRequestFileEdge', 'IssueCommentEdge']) {
  FIELD_RESOLVERS[type] = {
    node: (_ctx, source) => source.node,
    cursor: (_ctx, source) => source.cursor,
  };
}
// Payload wrappers.
FIELD_RESOLVERS.CreateIssuePayload = { issue: (_ctx, s) => s.issue, clientMutationId: (_ctx, s) => s.clientMutationId ?? null };
FIELD_RESOLVERS.CloseIssuePayload = { issue: (_ctx, s) => s.issue, clientMutationId: (_ctx, s) => s.clientMutationId ?? null };
FIELD_RESOLVERS.CreatePullRequestPayload = { pullRequest: (_ctx, s) => s.pullRequest, clientMutationId: (_ctx, s) => s.clientMutationId ?? null };
FIELD_RESOLVERS.MergePullRequestPayload = { pullRequest: (_ctx, s) => s.pullRequest, clientMutationId: (_ctx, s) => s.clientMutationId ?? null };
FIELD_RESOLVERS.AddCommentPayload = {
  commentEdge: (_ctx, s) => s.commentEdge,
  subject: (_ctx, s) => s.subject ?? null,
  clientMutationId: (_ctx, s) => s.clientMutationId ?? null,
};

interface ExecState {
  ctx: Ctx;
  document: Document;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function directiveAllows(field: FieldNode, variables: Record<string, unknown>): boolean {
  for (const directive of field.directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = valueOf(arg.value, variables);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

function executeSelectionSet(state: ExecState, source: Wrapped | null, typeName: string, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.document.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelectionSet(state, source, typeName, fragment.selection));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(state, source, typeName, selection.selection));
      }
      continue;
    }
    const field = selection.field;
    if (!directiveAllows(field, state.variables)) continue;
    const key = field.alias ?? field.name;
    out[key] = executeField(state, source, typeName, field);
  }
  return out;
}

function executeField(state: ExecState, source: Wrapped | null, typeName: string, field: FieldNode): unknown {
  const { ctx } = state;
  const args = argsOf(field, state.variables);
  if (field.name === '__typename') return typeName;
  if (field.name === '__type' && typeName === 'Query') {
    const name = String(args.name ?? '');
    if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
    const wrapped = typeWrap(name);
    return field.selection === undefined ? wrapped : executeSelectionSet(state, wrapped, '__Type', field.selection);
  }
  if (field.name === '__schema' && typeName === 'Query') {
    const wrapped = wrap('__Schema', {});
    return field.selection === undefined ? wrapped : executeSelectionSet(state, wrapped, '__Schema', field.selection);
  }

  let value: unknown;
  if (typeName === 'Query') {
    if (field.name === 'viewer') value = viewerWrap();
    else if (field.name === 'repository') {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      value = repo === undefined ? null : repoWrap(ctx, repo);
    } else if (field.name === 'node') {
      value = nodeByGlobalId(ctx, String(args.id ?? ''));
    } else if (field.name === 'user') {
      value = args.login === VIEWER.login ? viewerWrap() : null;
    } else {
      state.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
      return null;
    }
  } else if (typeName === 'Mutation') {
    value = executeMutation(state, field, args);
    if (value === undefined) {
      state.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
    }
  } else {
    const resolvers = FIELD_RESOLVERS[typeName];
    const resolver = resolvers?.[field.name];
    if (resolver === undefined || source === null) {
      state.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      return null;
    }
    value = resolver(ctx, source, args);
  }

  if (value === null || value === undefined) return null;
  if (field.selection === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__type' in (item as object)) {
        const wrapped = item as Wrapped;
        return executeSelectionSet(state, wrapped, wrapped.__type, field.selection as SelectionNode[]);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__type' in (value as object)) {
    const wrapped = value as Wrapped;
    return executeSelectionSet(state, wrapped, wrapped.__type, field.selection);
  }
  return value;
}

function executeMutation(state: ExecState, field: FieldNode, args: Record<string, unknown>): unknown {
  const { ctx } = state;
  const input = (args.input as Record<string, unknown> | undefined) ?? args;
  const finish = (payloadType: string, payload: Record<string, unknown>): unknown => {
    const wrapped = wrap(payloadType, { ...payload, clientMutationId: input.clientMutationId ?? null });
    return field.selection === undefined ? wrapped : executeSelectionSet(state, wrapped, payloadType, field.selection);
  };
  switch (field.name) {
    case 'createIssue': {
      const repo = ctx.forge.findRepoById(Number(parseGlobalId(String(input.repositoryId ?? ''))?.key ?? 'NaN'));
      if (repo === undefined) {
        state.errors.push({ message: 'Repository not found' });
        return null;
      }
      const issue = gqlCreateIssue(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''));
      return finish('CreateIssuePayload', { issue: issueWrap(repo, issue) });
    }
    case 'closeIssue': {
      const node = nodeByGlobalId(ctx, String(input.issueId ?? ''));
      if (node === null || node.__type !== 'Issue') {
        state.errors.push({ message: 'Issue not found' });
        return null;
      }
      const issue = node.issue as Issue;
      issue.state = 'closed';
      issue.updatedAt = isoNow();
      return finish('CloseIssuePayload', { issue: node });
    }
    case 'createPullRequest': {
      const repo = ctx.forge.findRepoById(Number(parseGlobalId(String(input.repositoryId ?? ''))?.key ?? 'NaN'));
      if (repo === undefined) {
        state.errors.push({ message: 'Repository not found' });
        return null;
      }
      const pull = gqlCreatePull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (pull === null) {
        state.errors.push({ message: 'Head or base branch not found' });
        return null;
      }
      pull.id = ctx.forge.allocIssueId();
      return finish('CreatePullRequestPayload', { pullRequest: pullWrap(repo, pull) });
    }
    case 'mergePullRequest': {
      const node = nodeByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (node === null || node.__type !== 'PullRequest') {
        state.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const repo = node.repo as Repo;
      const pull = node.pull as Pull;
      const outcome = gqlMergePull(repo, pull);
      if (outcome === 'conflict') {
        state.errors.push({ message: 'Pull request is not mergeable' });
        return finish('MergePullRequestPayload', { pullRequest: node });
      }
      return finish('MergePullRequestPayload', { pullRequest: node });
    }
    case 'addComment': {
      const node = nodeByGlobalId(ctx, String(input.subjectId ?? ''));
      if (node === null || node.__type !== 'Issue') {
        state.errors.push({ message: 'Subject not found' });
        return null;
      }
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const comment = { id: ctx.forge.allocCommentId(), body: String(input.body ?? ''), createdAt: isoNow() };
      issue.comments.push(comment);
      issue.updatedAt = isoNow();
      const wrapped = commentWrap(repo, issue, comment);
      const edge = wrap('IssueCommentEdge', { node: wrapped, cursor: cursorFor(issue.comments.length - 1) });
      return finish('AddCommentPayload', { commentEdge: edge, subject: node });
    }
    default:
      return undefined;
  }
}

/** Execute one GraphQL document; returns the response payload (without HTTP framing). */
export function executeGraphQL(forge: Forge, base: string, body: unknown): Record<string, unknown> {
  const ctx: Ctx = { forge, base };
  const request = (body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  if (typeof request.query !== 'string') return { errors: [{ message: 'A query string is required' }] };
  let document: Document;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    document.operations.find((op) => op.name === request.operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in document' }] };
  const variables: Record<string, unknown> = { ...(request.variables ?? {}) };
  for (const def of operation.varDefs) {
    if (variables[def.name] === undefined && def.defaultValue !== undefined) {
      variables[def.name] = valueOf(def.defaultValue, variables);
    }
  }
  const state: ExecState = { ctx, document, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(state, null, rootType, operation.selection);
  const response: Record<string, unknown> = { data };
  if (state.errors.length > 0) response.errors = state.errors;
  return response;
}
