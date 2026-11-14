// The MCP endpoint: JSON-RPC 2.0 over POST /mcp, in both protocol eras the harness speaks —
// `server/discover` (2026) and `initialize` (2025) — with the six canonical GitHub tools backed by
// the same store as REST, so objects created here read back identically over REST.

import { VIEWER, type Forge, type Repo } from './store.ts';
import { gqlCreateIssue, gqlCreatePull, gqlMergePull } from './graphql.ts';

export interface McpHttpResult {
  status: number;
  body: string; // empty for notifications
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

// The tool list is built once and served verbatim: two tools/list calls must be byte-identical.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        default_branch: { type: 'string', description: 'The default branch name.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

export type RepoView = (repo: Repo) => Record<string, unknown>;
export type IssueView = (repo: Repo, issue: import('./store.ts').Issue) => Record<string, unknown>;
export type PullView = (repo: Repo, pull: import('./store.ts').Pull) => Record<string, unknown>;

export interface McpViews {
  repo: RepoView;
  issue: IssueView;
  pull: PullView;
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(id: unknown, value: unknown, isError = false): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError,
    },
  });
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let name = typeof args.repo === 'string' ? args.repo : undefined;
  if ((owner === undefined || name === undefined) && typeof args.full_name === 'string') {
    const split = args.full_name.indexOf('/');
    if (split > 0) {
      owner = args.full_name.slice(0, split);
      name = args.full_name.slice(split + 1);
    }
  }
  if (owner === undefined || name === undefined) return undefined;
  return forge.getRepo(owner, name);
}

function callTool(forge: Forge, views: McpViews, name: string, args: Record<string, unknown>, id: unknown): string {
  switch (name) {
    case 'create_repo': {
      if (typeof args.name !== 'string' || args.name === '') return toolResult(id, { message: 'name is required' }, true);
      if (forge.getRepo(VIEWER.login, args.name) !== undefined) return toolResult(id, { message: 'name already exists' }, true);
      const repo = forge.createRepo(
        args.name,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
        typeof args.default_branch === 'string' && args.default_branch !== '' ? args.default_branch : 'main',
      );
      return toolResult(id, views.repo(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(forge, args);
      if (repo === undefined) return toolResult(id, { message: 'Not Found' }, true);
      return toolResult(id, views.repo(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(forge, args);
      if (repo === undefined) return toolResult(id, { message: 'Not Found' }, true);
      if (typeof args.title !== 'string' || args.title === '') return toolResult(id, { message: 'title is required' }, true);
      const issue = gqlCreateIssue(forge, repo, args.title, typeof args.body === 'string' ? args.body : '');
      return toolResult(id, views.issue(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(forge, args);
      if (repo === undefined) return toolResult(id, { message: 'Not Found' }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => views.issue(repo, issue));
      return toolResult(id, list);
    }
    case 'create_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === undefined) return toolResult(id, { message: 'Not Found' }, true);
      if (typeof args.title !== 'string' || typeof args.head !== 'string' || typeof args.base !== 'string') {
        return toolResult(id, { message: 'title, head and base are required' }, true);
      }
      const pull = gqlCreatePull(repo, args.title, typeof args.body === 'string' ? args.body : '', args.head, args.base);
      if (pull === null) return toolResult(id, { message: 'Head or base branch not found' }, true);
      pull.id = forge.allocIssueId();
      return toolResult(id, views.pull(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === undefined) return toolResult(id, { message: 'Not Found' }, true);
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolResult(id, { message: 'Not Found' }, true);
      const outcome = gqlMergePull(repo, pull);
      if (outcome === 'conflict') return toolResult(id, { message: 'Pull request is not mergeable' }, true);
      return toolResult(id, views.pull(repo, pull));
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/** Handle one POST /mcp body. Auth is enforced by the caller. */
export function handleMcp(forge: Forge, views: McpViews, rawBody: string): McpHttpResult {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: body is not valid JSON') };
  }
  const { id, method } = request;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            supportedVersions: ['2026-07-28', '2025-11-25'],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          },
        }),
      };
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { protocolVersion: clientVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        }),
      };
    }
    case 'ping':
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: {} }) };
    case 'tools/list':
      return { status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_JSON}}` };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};
      if (!TOOLS.some((tool) => tool.name === toolName)) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
      return { status: 200, body: callTool(forge, views, toolName, toolArgs, id) };
    }
    default:
      if (isNotification || (typeof method === 'string' && method.startsWith('notifications/'))) {
        return { status: 202, body: '' };
      }
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${String(method)}`) };
  }
}
