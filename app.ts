// The forge's HTTP surface: git smart-HTTP, REST v3, GraphQL v4 and MCP, all over one in-memory
// store. Routing and auth live here; the protocol engines live in git.ts, graphql.ts and mcp.ts.
//
// Auth model: the trial hands the entry a token in MAKEFUN_SHOP_TOKEN. Every surface requires
// `Authorization: Bearer <token>`; repositories exist only under the viewer's login, and any other
// owner answers 404 (never 403), matching the harness's isolation expectations.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, isoNow, threeWayMerge, diffFlats, type Issue, type Pull, type Repo } from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import { handleFetchV0, handleFetchV2, handleInfoRefs, handleLsRefs, handleReceivePack, type GitResponse } from './git.ts';
import { executeGraphQL, gqlCreateIssue, gqlCreatePull, gqlMergePull } from './graphql.ts';
import { handleMcp, type McpViews } from './mcp.ts';

const forge = new Forge();
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------------------------
// views (shared by REST and MCP so both surfaces describe the same objects identically)

export function userView(base: string) {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    avatar_url: '',
    gravatar_id: '',
    html_url: `${base}/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoView(repo: Repo, base: string) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: userView(base),
    html_url: `${base}/${repo.fullName}`,
    clone_url: `${base}/${repo.fullName}.git`,
    ssh_url: `git@forge.invalid:${repo.fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    language: null,
  };
}

function labelView(repo: Repo, name: string) {
  const label = repo.labels.get(name);
  const id = [...repo.labels.keys()].indexOf(name) + 1;
  return {
    id,
    node_id: `LA_${repo.id}_${id}`,
    name,
    color: label?.color ?? '000000',
    default: false,
    description: null,
    url: '',
  };
}

export function issueView(repo: Repo, issue: Issue, base: string) {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelView(repo, name)),
    user: userView(base),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${base}/${repo.fullName}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.fullName}`,
  };
}

export function commentView(repo: Repo, issue: Issue, comment: Issue['comments'][number], base: string) {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userView(base),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${base}/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
  };
}

function pullMergeable(repo: Repo, pull: Pull): boolean | null {
  if (pull.merged) return true;
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return null;
  const base = repo.mergeBase(headTip, baseTip);
  const ancestorTree = base === undefined ? undefined : repo.commitView(base)?.tree;
  const headTree = repo.commitView(headTip)?.tree;
  const baseTree = repo.commitView(baseTip)?.tree;
  if (headTree === undefined || baseTree === undefined) return null;
  return !threeWayMerge(repo, ancestorTree, headTree, baseTree).conflict;
}

export function pullView(repo: Repo, pull: Pull, base: string) {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: userView(base),
    head: {
      label: `${VIEWER.login}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip ?? null,
      user: userView(base),
      repo: repoView(repo, base),
    },
    base: {
      label: `${VIEWER.login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip ?? null,
      user: userView(base),
      repo: repoView(repo, base),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    mergeable_state: pull.merged ? 'clean' : 'unknown',
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${base}/${repo.fullName}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function identView(ident: string) {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitView(repo: Repo, oid: string, base: string) {
  const view = repo.commitView(oid);
  if (view === undefined) return null;
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: identView(view.author),
      committer: identView(view.committer),
      message: view.message,
      tree: { sha: view.tree, url: '' },
      comment_count: 0,
    },
    author: userView(base),
    committer: userView(base),
    parents: view.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: `${base}/${repo.fullName}/commit/${oid}`,
    url: `${base}/api/v3/repos/${repo.fullName}/commits/${oid}`,
  };
}

const mcpViews: McpViews = {
  repo: (repo) => repoView(repo, ''),
  issue: (repo, issue) => issueView(repo, issue, ''),
  pull: (repo, pull) => pullView(repo, pull, ''),
};

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

interface Reply {
  status: number;
  body: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body: JSON.stringify(value), contentType: 'application/json; charset=utf-8', headers };
}

function notFound(message = 'Not Found'): Reply {
  return json(404, { message });
}

function unprocessable(message: string): Reply {
  return json(422, { message, errors: [{ message }] });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token === undefined || token === '') return true; // local development only; trials always set it
  return req.headers.authorization === `Bearer ${token}`;
}

function baseOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function paginate<T>(req: IncomingMessage, url: URL, items: T[], base: string): { page: T[]; headers: Record<string, string> } {
  void req;
  const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? '30') || 30, 1), 100);
  const pageNumber = Math.max(Number(url.searchParams.get('page') ?? '1') || 1, 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    // Link URLs must stay on the origin the client dialed — build them from the Host-derived
    // base, never from the internal parse origin.
    const buildLink = (targetPage: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('page', String(targetPage));
      params.set('per_page', String(perPage));
      return `${base}${url.pathname}?${params.toString()}`;
    };
    headers.Link = `<${buildLink(pageNumber + 1)}>; rel="next", <${buildLink(Math.ceil(items.length / perPage))}>; rel="last"`;
  }
  return { page, headers };
}

// ---------------------------------------------------------------------------------------------
// REST handlers

function createRepoHandler(body: Record<string, unknown>, base: string): Reply {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || name.includes('/') || name.includes(' ')) return unprocessable('name is required and must be a valid repository name');
  if (forge.getRepo(VIEWER.login, name) !== undefined) return unprocessable('name already exists on this account');
  const repo = forge.createRepo(
    name,
    body.private === true,
    typeof body.description === 'string' ? body.description : '',
    typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main',
  );
  return json(201, repoView(repo, base));
}

function repoScoped(owner: string, name: string): Repo | undefined {
  return forge.getRepo(owner, name);
}

function contentsGet(repo: Repo, path: string, refParam: string | null, base: string): Reply {
  const tip = refParam !== null && refParam !== '' ? repo.resolveCommit(refParam) : repo.peelToCommit(repo.refs.get(repo.headRef) ?? '');
  if (tip === undefined) return notFound();
  const view = repo.commitView(tip);
  if (view === undefined) return notFound();
  // Walk to the target tree.
  let treeOid = view.tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const entries = parseTree(repo.getObject(treeOid)?.data ?? Buffer.alloc(0));
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return notFound();
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        treeOid = entry.oid;
        break;
      }
      const blob = repo.getObject(entry.oid);
      if (blob === undefined) return notFound();
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: entry.oid,
        size: blob.data.length,
        name: entry.name,
        path,
        url: '',
        html_url: `${base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
        download_url: '',
      });
    }
    if (entry.mode !== '40000') return notFound();
    treeOid = entry.oid;
  }
  const entries = parseTree(repo.getObject(treeOid)?.data ?? Buffer.alloc(0));
  const listing = entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.getObject(entry.oid)?.data.length ?? 0),
    url: '',
    html_url: '',
    download_url: entry.mode === '40000' ? null : '',
  }));
  return json(200, listing);
}

function contentsPut(repo: Repo, path: string, body: Record<string, unknown>, base: string): Reply {
  if (path === '') return unprocessable('path is required');
  const message = typeof body.message === 'string' ? body.message : '';
  if (message === '') return unprocessable('message is required');
  if (typeof body.content !== 'string') return unprocessable('content is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  if (branch !== repo.defaultBranch && repo.branchTip(branch) === undefined) return notFound('Branch not found');
  const tip = repo.branchTip(branch);
  const flat = tip === undefined ? new Map() : repo.flatOfCommit(tip);
  const existing = flat.get(path);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined) {
    if (sha === undefined) return unprocessable('sha must be supplied when updating an existing file');
    if (sha !== existing.oid) return json(409, { message: 'sha does not match the current file' });
  }
  const bytes = Buffer.from(body.content, 'base64');
  const blobOid = repo.putObject('blob', bytes);
  const commit = repo.commitOnBranch(branch, message, (draft) => {
    draft.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  });
  return json(existing === undefined ? 201 : 200, {
    content: {
      name: path.split('/').pop() as string,
      path,
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      url: '',
      html_url: `${base}/${repo.fullName}/blob/${branch}/${path}`,
      download_url: '',
    },
    commit: { sha: commit, message, url: '', html_url: `${base}/${repo.fullName}/commit/${commit}` },
  });
}

function contentsDelete(repo: Repo, path: string, body: Record<string, unknown>): Reply {
  const message = typeof body.message === 'string' ? body.message : '';
  if (message === '') return unprocessable('message is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.branchTip(branch);
  if (tip === undefined) return notFound();
  const flat = repo.flatOfCommit(tip);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (sha === undefined) return unprocessable('sha must be supplied when deleting a file');
  if (sha !== existing.oid) return json(409, { message: 'sha does not match the current file' });
  const commit = repo.commitOnBranch(branch, message, (draft) => {
    draft.delete(path);
  });
  return json(200, { content: null, commit: { sha: commit, message, url: '' } });
}

function restRoute(req: IncomingMessage, url: URL, raw: Buffer, base: string): Reply {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: `${base}/api/v3/user`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${base}/api/v3/search/issues`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
    }, { 'X-OAuth-Scopes': 'repo, write:org, admin:org' });
  }
  if (rest[0] === 'meta' && method === 'GET') {
    return json(200, {
      hook_attributes: ['active'],
      github_services_sha: 'forge',
      verifiable_password_authentication: false,
      installed_version: '1.0.0-forge',
    });
  }
  if (rest[0] === 'rate_limit' && method === 'GET') {
    return json(200, { rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') return json(200, userView(base));
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
      return createRepoHandler(parsed.value, base);
    }
    if (method === 'GET') {
      const { page, headers } = paginate(req, url, forge.listRepos().map((repo) => repoView(repo, base)), base);
      return json(200, page, headers);
    }
    return notFound();
  }
  if (rest[0] !== 'repos' || rest.length < 3) return notFound();
  const repo = repoScoped(rest[1], rest[2]);
  if (repo === undefined) return notFound();
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoView(repo, base));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') repo.defaultBranch = parsed.value.default_branch;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== '' && parsed.value.name !== repo.name) {
        forge.deleteRepo(repo);
        repo.name = parsed.value.name;
        forge.repos.set(repo.fullName, repo);
      }
      repo.touch();
      return json(200, repoView(repo, base));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204, body: '' };
    }
    return notFound();
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return contentsGet(repo, path, url.searchParams.get('ref'), base);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
    if (method === 'PUT') return contentsPut(repo, path, parsed.value, base);
    if (method === 'DELETE') return contentsDelete(repo, path, parsed.value);
    return notFound();
  }

  if (tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
    const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
    if (!ref.startsWith('refs/') || sha === '') return unprocessable('ref and sha are required');
    const object = repo.getObject(sha);
    if (object === undefined) return unprocessable('sha does not name an object in this repository');
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    repo.invalidateHistoryCaches();
    repo.touch();
    return json(201, { ref, node_id: `REF_${ref}`, object: { sha, type: object.type, url: '' } });
  }

  if (tail[0] === 'branches' && method === 'GET') {
    if (tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, branches);
    }
    const name = tail.slice(1).join('/');
    const tip = repo.branchTip(name);
    if (tip === undefined) return notFound();
    return json(200, { name, commit: { sha: tip, url: '' }, protected: false });
  }

  if (tail[0] === 'commits' && method === 'GET') {
    if (tail.length === 2) {
      const view = commitView(repo, tail[1], base);
      return view === null ? notFound() : json(200, view);
    }
    const shaParam = url.searchParams.get('sha');
    const start = shaParam !== null && shaParam !== '' ? repo.resolveCommit(shaParam) : repo.peelToCommit(repo.refs.get(repo.headRef) ?? '');
    if (start === undefined) return json(200, []);
    const views = repo.historyFrom(start).map((oid) => commitView(repo, oid, base)).filter((view) => view !== null);
    const { page, headers } = paginate(req, url, views, base);
    return json(200, page, headers);
  }

  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      const color = typeof parsed.value.color === 'string' ? parsed.value.color.replace(/^#/, '') : '';
      if (name === '' || color === '') return unprocessable('name and color are required');
      if (repo.labels.has(name)) return unprocessable('Label already exists');
      repo.labels.set(name, { name, color });
      repo.touch();
      return json(201, labelView(repo, name));
    }
    if (method === 'GET' && tail.length === 1) {
      return json(200, [...repo.labels.keys()].map((name) => labelView(repo, name)));
    }
    if (method === 'GET' && tail.length === 2) {
      if (!repo.labels.has(tail[1])) return notFound();
      return json(200, labelView(repo, tail[1]));
    }
    return notFound();
  }

  if (tail[0] === 'issues') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      if (title === '') return unprocessable('title is required');
      const labelNames = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).map(String) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return unprocessable(`Label '${name}' does not exist in this repository`);
      }
      const issue = gqlCreateIssue(forge, repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '');
      issue.labels = labelNames;
      return json(201, issueView(repo, issue, base));
    }
    if (method === 'GET' && tail.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(req, url, list.map((issue) => issueView(repo, issue, base)), base);
      return json(200, page, headers);
    }
    const number = Number(tail[1]);
    const issue = repo.issues.get(number);
    const pull = repo.pulls.get(number);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (issue !== undefined) return json(200, issueView(repo, issue, base));
        if (pull !== undefined) {
          return json(200, {
            ...issueView(repo, { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, labels: [], comments: [], createdAt: pull.createdAt, updatedAt: pull.updatedAt }, base),
            pull_request: { url: `${base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`, html_url: `${base}/${repo.fullName}/pull/${pull.number}` },
          });
        }
        return notFound();
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
        if (issue !== undefined) {
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
          if (Array.isArray(parsed.value.labels)) {
            const names = (parsed.value.labels as unknown[]).map((entry) =>
              typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? ''),
            );
            for (const name of names) if (!repo.labels.has(name)) return unprocessable(`Label '${name}' does not exist in this repository`);
            issue.labels = names;
          }
          issue.updatedAt = isoNow();
          repo.touch();
          return json(200, issueView(repo, issue, base));
        }
        if (pull !== undefined) {
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
            pull.state = parsed.value.state;
            pull.updatedAt = isoNow();
          }
          return json(200, pullView(repo, pull, base));
        }
        return notFound();
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const target = issue ?? (pull !== undefined ? { comments: pullCommentsOf(repo, pull), number: pull.number } : undefined);
      if (issue === undefined && pull === undefined) return notFound();
      if (method === 'GET') {
        const list = (issue !== undefined ? issue.comments : pullCommentsOf(repo, pull as Pull))
          .map((comment) => commentView(repo, (issue ?? synthIssue(repo, pull as Pull)), comment, base));
        return json(200, list);
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        if (body === '') return unprocessable('body is required');
        const comment = { id: forge.allocCommentId(), body, createdAt: isoNow() };
        if (issue !== undefined) {
          issue.comments.push(comment);
          issue.updatedAt = isoNow();
          return json(201, commentView(repo, issue, comment, base));
        }
        const comments = pullCommentsOf(repo, pull as Pull);
        comments.push(comment);
        return json(201, commentView(repo, synthIssue(repo, pull as Pull), comment, base));
      }
      void target;
      return notFound();
    }
    return notFound();
  }

  if (tail[0] === 'pulls') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return json(400, { message: 'Body is not valid JSON' });
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
      const baseBranch = typeof parsed.value.base === 'string' ? parsed.value.base : '';
      if (title === '' || head === '' || baseBranch === '') return unprocessable('title, head and base are required');
      if (repo.branchTip(head) === undefined) return unprocessable(`Head branch '${head}' does not exist`);
      if (repo.branchTip(baseBranch) === undefined) return unprocessable(`Base branch '${baseBranch}' does not exist`);
      if (repo.branchTip(head) === repo.branchTip(baseBranch)) return unprocessable('No commits between branches');
      const pull = gqlCreatePull(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', head, baseBranch);
      if (pull === null) return unprocessable('Could not create pull request');
      pull.id = forge.allocIssueId();
      return json(201, pullView(repo, pull, base));
    }
    if (method === 'GET' && tail.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed' || pull.merged);
      list.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(req, url, list.map((pull) => pullView(repo, pull, base)), base);
      return json(200, page, headers);
    }
    const number = Number(tail[1]);
    const pull = repo.pulls.get(number);
    if (tail.length === 2 && method === 'GET') {
      return pull === undefined ? notFound() : json(200, pullView(repo, pull, base));
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      const headTip = repo.branchTip(pull.headRef);
      const baseTip = repo.branchTip(pull.baseRef);
      if (headTip === undefined || baseTip === undefined) return json(200, []);
      const mergeBase = repo.mergeBase(headTip, baseTip);
      const before = mergeBase === undefined ? new Map() : repo.flatOfCommit(mergeBase);
      const files = diffFlats(repo, before, repo.flatOfCommit(headTip)).map((file) => ({
        sha: '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      return json(200, files);
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const outcome = gqlMergePull(repo, pull);
      if (outcome === 'conflict') return json(405, { message: 'Pull Request is not mergeable', documentation_url: '' });
      if (outcome === 'not-open') return json(405, { message: 'Pull Request is not mergeable', documentation_url: '' });
      return json(200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

// Pull-request conversation comments live in a side table keyed by pull number (GitHub unifies
// issue and pull comments; the suite only exercises issue comments, but the route should not 500).
const pullComments = new Map<string, Issue['comments']>();
function pullCommentsOf(repo: Repo, pull: Pull): Issue['comments'] {
  const key = `${repo.id}:${pull.number}`;
  let list = pullComments.get(key);
  if (list === undefined) {
    list = [];
    pullComments.set(key, list);
  }
  return list;
}
function synthIssue(repo: Repo, pull: Pull): Issue {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    comments: pullCommentsOf(repo, pull),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// git routing

function gitRoute(req: IncomingMessage, url: URL, raw: Buffer): Reply | GitResponse {
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return notFound();
  const owner = decodeURIComponent(segments[0]);
  const repoSegment = decodeURIComponent(segments[1]);
  if (!repoSegment.endsWith('.git')) return notFound();
  const repo = forge.getRepo(owner, repoSegment.slice(0, -4));
  if (repo === undefined) return { status: 404, body: 'Not Found\n', contentType: 'text/plain' };
  const action = segments[2] ?? '';
  if (action === 'info' && segments[3] === 'refs' && req.method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 400, body: 'Unsupported service\n', contentType: 'text/plain' };
    }
    const v2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    return handleInfoRefs(repo, service, v2);
  }
  if (action === 'git-upload-pack' && req.method === 'POST') {
    try {
      const head = raw.subarray(0, Math.min(raw.length, 64)).toString('utf8');
      if (head.includes('command=ls-refs')) return handleLsRefs(repo, raw);
      const v2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      return v2 ? handleFetchV2(repo, raw) : handleFetchV0(repo, raw);
    } catch {
      return { status: 400, body: 'Bad Request\n', contentType: 'text/plain' };
    }
  }
  if (action === 'git-receive-pack' && req.method === 'POST') {
    try {
      return handleReceivePack(repo, raw);
    } catch {
      return { status: 400, body: 'Bad Request\n', contentType: 'text/plain' };
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// the server

async function dispatch(req: IncomingMessage): Promise<Reply | GitResponse> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const base = baseOf(req);
  const pathname = url.pathname;

  if (pathname === '/healthz') return { status: 200, body: 'ok', contentType: 'text/plain' };

  const needsAuth = pathname.startsWith('/api/') || pathname === '/mcp' || /^\/[^/]+\/[^/]+\.git(\/|$)/.test(pathname);
  if (needsAuth && !authorized(req)) return json(401, { message: 'Unauthorized' });

  if (pathname === '/api/graphql') {
    if (req.method !== 'POST') return json(405, { message: 'Method Not Allowed' });
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(400, { errors: [{ message: 'Body is not valid JSON' }] });
    }
    if (Array.isArray(parsed)) return json(200, parsed.map((entry) => executeGraphQL(forge, base, entry)));
    return json(200, executeGraphQL(forge, base, parsed));
  }

  if (pathname === '/mcp') {
    if (req.method !== 'POST') return json(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    const raw = await readBody(req);
    const result = handleMcp(forge, mcpViews, raw.toString('utf8'));
    return { status: result.status, body: result.body, contentType: 'application/json' };
  }

  if (pathname.startsWith('/api/v3')) {
    const raw = req.method === 'GET' || req.method === 'DELETE' && !pathname.includes('/contents/') ? Buffer.alloc(0) : await readBody(req);
    return restRoute(req, url, raw, base);
  }

  if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(pathname)) {
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    return gitRoute(req, url, raw);
  }

  return notFound();
}

/** The entry's HTTP server: the whole forge surface, ready to listen on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    dispatch(req)
      .then((reply) => {
        const headers: Record<string, string> = {
          'Content-Type': reply.contentType ?? 'application/json; charset=utf-8',
          'X-GitHub-Request-Id': requestId(),
          ...(reply.headers ?? {}),
        };
        res.writeHead(reply.status, headers);
        res.end(reply.body);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': requestId() });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      });
  });
  return server;
}
