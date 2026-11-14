// The forge's state: one seeded account (the viewer), repositories with their git object stores,
// refs, labels, issues, comments and pull requests. Everything lives in memory; the trial is one
// process and the state export never includes this data, so no persistence is needed.
//
// The viewer's identity is the forge's seeded admin account. The conformance world addresses
// repositories only under this login and expects any other owner to answer 404.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export interface Viewer {
  readonly login: string;
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

export const VIEWER: Viewer = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

// A monotonic clock for server-made commits and timestamps: starts at the trial's "now" when the
// harness provides one, else at wall time; every use advances it a second so history stays ordered.
let clockEpoch = (() => {
  const fromEnv = process.env.MAKEFUN_TRIAL_NOW;
  if (fromEnv !== undefined) {
    const parsed = Date.parse(fromEnv);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
})();

export function tickClock(): number {
  clockEpoch += 1;
  return clockEpoch;
}

export function isoNow(): string {
  return new Date(tickClock() * 1000).toISOString();
}

export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${tickClock()} +0000`;
}

// ---------------------------------------------------------------------------------------------
// global ids for GraphQL: opaque, stable, and reversible by this server only.

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const split = decoded.indexOf(':');
    if (split <= 0) return null;
    return { type: decoded.slice(0, split), key: decoded.slice(split + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// domain records

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[]; // label names, in the order attached
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string; // short branch name
  baseRef: string; // short branch name
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export class Repo {
  readonly id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>(); // full refname -> oid
  headRef: string; // symbolic HEAD target, e.g. "refs/heads/main"
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1; // issues and pull requests share one per-repo sequence, as on GitHub
  private flatCache = new Map<string, Map<string, FlatEntry>>();
  private ancestorCache = new Map<string, Set<string>>();
  private commitCache = new Map<string, ReturnType<typeof parseCommit>>();

  constructor(id: number, name: string, isPrivate: boolean, description: string, defaultBranch: string) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = defaultBranch;
    this.headRef = `refs/heads/${defaultBranch}`;
    const now = isoNow();
    this.createdAt = now;
    this.updatedAt = now;
  }

  get fullName(): string {
    return `${VIEWER.login}/${this.name}`;
  }

  touch(): void {
    this.updatedAt = isoNow();
  }

  // ---- object store ----

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  commitView(oid: string) {
    const cached = this.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    const view = parseCommit(object.data);
    this.commitCache.set(oid, view);
    return view;
  }

  /** Follow a tag object (or a commit) down to the commit it ultimately points at. */
  peelToCommit(oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** The commit a ref-like value names: a full ref, a short branch name, or a raw commit oid. */
  resolveCommit(refish: string): string | undefined {
    if (this.refs.has(refish)) {
      const target = this.refs.get(refish) as string;
      return this.peelToCommit(target);
    }
    const asBranch = `refs/heads/${refish}`;
    if (this.refs.has(asBranch)) return this.peelToCommit(this.refs.get(asBranch) as string);
    const asTag = `refs/tags/${refish}`;
    if (this.refs.has(asTag)) return this.peelToCommit(this.refs.get(asTag) as string);
    if (/^[0-9a-f]{40}$/.test(refish) && this.commitView(refish) !== undefined) return refish;
    return undefined;
  }

  branchTip(shortName: string): string | undefined {
    return this.refs.get(`refs/heads/${shortName}`);
  }

  // ---- trees ----

  /** Flatten a tree (by oid) into path -> {oid, mode}; cached, trees are immutable. */
  flattenTree(treeOid: string): Map<string, FlatEntry> {
    const cached = this.flatCache.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, out);
    return out;
  }

  flatOfCommit(commitOid: string): Map<string, FlatEntry> {
    const view = this.commitView(commitOid);
    if (view === undefined) return new Map();
    return this.flattenTree(view.tree);
  }

  /** Rebuild nested tree objects from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(flat: ReadonlyMap<string, FlatEntry>): string {
    interface Node {
      files: Map<string, FlatEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        let next = node.dirs.get(segments[i]);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(segments[i], next);
        }
        node = next;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const emit = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return emit(root);
  }

  // ---- history ----

  /** All ancestors of `oid`, including itself. */
  ancestorsOf(oid: string): Set<string> {
    const cached = this.ancestorCache.get(oid);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (out.has(current)) continue;
      const view = this.commitView(current);
      if (view === undefined) continue;
      out.add(current);
      for (const parent of view.parents) stack.push(parent);
    }
    this.ancestorCache.set(oid, out);
    return out;
  }

  /**
   * Targeted ancestry search: walk from the descendant and stop the moment the ancestor is
   * found. The push path calls this once per ref update, and sequential pushes onto a growing
   * branch find their answer one step away — building the full ancestor set each time would make
   * a 200-push sequence quadratic.
   */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const view = this.commitView(current);
      if (view === undefined) continue;
      for (const parent of view.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** A best common ancestor of two commits, or undefined when their histories are unrelated. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsA = this.ancestorsOf(a);
    if (ancestorsA.has(b)) return b;
    if (this.ancestorsOf(b).has(a)) return a;
    // Breadth-first from b so the first shared commit is a nearest one.
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsA.has(current)) return current;
      const view = this.commitView(current);
      if (view !== undefined) queue.push(...view.parents);
    }
    return undefined;
  }

  /** Commits reachable from `tip`, newest first (a commit always precedes its parents). */
  historyFrom(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      const view = this.commitView(current);
      if (view === undefined) continue;
      seen.add(current);
      order.push(current);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]);
    }
    return order;
  }

  invalidateHistoryCaches(): void {
    this.ancestorCache.clear();
  }

  // ---- server-side commits (contents API, merges) ----

  createCommit(fields: { tree: string; parents: readonly string[]; message: string }): string {
    const ident = viewerIdent();
    const data = buildCommit({ tree: fields.tree, parents: fields.parents, author: ident, committer: ident, message: fields.message });
    return this.putObject('commit', data);
  }

  /**
   * Apply `change` to the flat file map of `branch`'s tip (or of an empty tree when the branch is
   * unborn) and commit the result on that branch. Returns the new commit oid.
   */
  commitOnBranch(branch: string, message: string, change: (flat: Map<string, FlatEntry>) => void): string {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref);
    const flat = tip === undefined ? new Map<string, FlatEntry>() : new Map(this.flatOfCommit(tip));
    change(flat);
    const tree = this.buildTreeFromFlat(flat);
    const commit = this.createCommit({ tree, parents: tip === undefined ? [] : [tip], message });
    this.refs.set(ref, commit);
    this.invalidateHistoryCaches();
    this.touch();
    return commit;
  }
}

// ---------------------------------------------------------------------------------------------
// the forge

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;

  createRepo(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
    const repo = new Repo(this.nextRepoId, name, isPrivate, description, defaultBranch);
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  /** Repositories are only visible under the viewer's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  allocIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// ---------------------------------------------------------------------------------------------
// three-way tree merge + line diffs, shared by REST pulls and GraphQL mergeable

export interface MergeOutcome {
  readonly conflict: boolean;
  readonly tree?: string;
}

/** Squash-merge semantics over flat file maps: ancestor vs head vs current base. */
export function threeWayMerge(repo: Repo, ancestorTree: string | undefined, headTree: string, baseTree: string): MergeOutcome {
  const ancestor = ancestorTree === undefined ? new Map<string, FlatEntry>() : repo.flattenTree(ancestorTree);
  const head = repo.flattenTree(headTree);
  const base = repo.flattenTree(baseTree);
  const merged = new Map<string, FlatEntry>(base);
  const paths = new Set<string>([...ancestor.keys(), ...head.keys(), ...base.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const h = head.get(path);
    const b = base.get(path);
    const sameEntry = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (sameEntry(h, a)) continue; // head did not change it; base's version stands
    if (sameEntry(b, a)) {
      // only head changed it
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (sameEntry(h, b)) continue; // both sides made the same change
    return { conflict: true };
  }
  return { conflict: false, tree: repo.buildTreeFromFlat(merged) };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Longest-common-subsequence over lines; the files in play are small.
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

/** Diff two flat file maps with per-file line counts, GitHub's /pulls/{n}/files shape. */
export function diffFlats(repo: Repo, before: ReadonlyMap<string, FlatEntry>, after: ReadonlyMap<string, FlatEntry>): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const blobText = (entry?: FlatEntry): string => {
    if (entry === undefined) return '';
    const object = repo.getObject(entry.oid);
    return object === undefined ? '' : object.data.toString('utf8');
  };
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b?.oid === a?.oid && b?.mode === a?.mode) continue;
    const { additions, deletions } = countLineChanges(blobText(b), blobText(a));
    out.push({
      filename: path,
      status: b === undefined ? 'added' : a === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}
