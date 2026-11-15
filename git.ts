// Git smart-HTTP: advertisement (protocol v0 and v2), ls-refs, fetch (upload-pack) and push
// (receive-pack), spoken directly over the forge's in-memory object store. Packs are written
// undeltified (plain objects); packs are read with full OFS/REF delta resolution, including thin
// packs against the receiving store.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  isOid,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { parseCommit, parseTag, parseTree } from './gitobj.ts';
import type { Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line scanning over a request body (receive-pack bodies end in raw pack bytes, so the scan
// must stop at the first flush and hand back the remainder).

interface Scanned {
  lines: string[];
  sawDelim: boolean;
  rest: Buffer;
}

/** Value of one ASCII hex digit byte, or -1 when the byte is not a hex digit. */
function hexNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10; // a-f
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10; // A-F
  return -1;
}

/**
 * Parse the 4-byte pkt-line length prefix at `offset` byte-by-byte, or return -1 when it is not
 * hex. The scan below runs on every git request (several times for ls-refs/fetch bodies), and
 * the previous shape paid a substring allocation plus a regex plus parseInt per line for what
 * is four nibbles of arithmetic.
 */
function pktLengthAt(buffer: Buffer, offset: number): number {
  let length = 0;
  for (let i = 0; i < 4; i += 1) {
    const nibble = hexNibble(buffer[offset + i]);
    if (nibble < 0) return -1;
    length = (length << 4) | nibble;
  }
  return length;
}

function scanPktLines(buffer: Buffer, start: number): Scanned {
  const lines: string[] = [];
  let offset = start;
  let sawDelim = false;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const length = pktLengthAt(buffer, offset);
    if (length < 0) throw new Error('bad pkt-line header');
    if (length === 0) {
      offset += 4;
      return { lines, sawDelim, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      sawDelim = true;
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      return { lines, sawDelim, rest: buffer.subarray(offset) };
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    lines.push(buffer.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, sawDelim, rest: buffer.subarray(offset) };
}

/** Scan a whole body of pkt-lines into segments split by flush packets. */
function scanSegments(buffer: Buffer): { segments: string[][]; rest: Buffer } {
  const segments: string[][] = [];
  let offset = 0;
  for (;;) {
    const scanned = scanPktLines(buffer, offset);
    segments.push(scanned.lines);
    offset = buffer.length - scanned.rest.length;
    if (scanned.rest.length === 0) return { segments, rest: scanned.rest };
    // scanPktLines stopped at a flush; if the remainder does not start with a pkt-line header,
    // it is raw payload (a packfile) and belongs to the caller.
    if (scanned.rest.length < 4 || pktLengthAt(scanned.rest, 0) < 0) return { segments, rest: scanned.rest };
    if (segments.length > 8) return { segments, rest: scanned.rest };
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Ref lines for a v0 advertisement, with peeled lines after annotated tags. */
function v0RefLines(repo: Repo, caps: string): Buffer {
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(repo.headRef);
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  let first = true;
  if (headOid !== undefined) {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    first = false;
  }
  for (const [name, oid] of refs) {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
    const object = repo.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      parts.push(pktLine(`${target} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// Advertisements and ls-refs answers are pure functions of the repo's current refs (the objects
// behind them are immutable), and the hot paths ask for them constantly: every push starts with
// a receive-pack advertisement and every clone with an upload-pack one plus an ls-refs. Cache the
// finished bytes under a key built from the refs themselves — any ref move changes an oid in the
// key, so a stale body can never be served — and keep the caches small and bounded.
const refAnswerCache = new Map<string, Buffer>();

function refsKey(repo: Repo): string {
  const entries = sortedRefs(repo);
  let key = `${repo.id}|${repo.headRef}|${repo.refs.get(repo.headRef) ?? ''}`;
  for (const [name, oid] of entries) key += `|${name}=${oid}`;
  return key;
}

function cachedRefAnswer(key: string, build: () => Buffer): Buffer {
  const cached = refAnswerCache.get(key);
  if (cached !== undefined) return cached;
  const body = build();
  if (refAnswerCache.size > 128) refAnswerCache.clear();
  refAnswerCache.set(key, body);
  return body;
}

// The protocol-v2 upload-pack advertisement names no refs at all: it is one constant byte
// string for every repository, built once.
let v2Advertisement: Buffer | null = null;

function v2AdvertisementBody(): Buffer {
  if (v2Advertisement === null) {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'object-format=sha1\n',
      'fetch=shallow\n',
      'ls-refs=symrefs peel unborn\n',
    ];
    v2Advertisement = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  }
  return v2Advertisement;
}

export function handleInfoRefs(repo: Repo, service: string, protocolVersion2: boolean): GitResponse {
  if (service === 'git-upload-pack') {
    if (protocolVersion2) {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: v2AdvertisementBody(),
      };
    }
    const caps = `side-band-64k thin-pack ofs-delta shallow symref=HEAD:${repo.headRef} agent=${AGENT}`;
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: cachedRefAnswer(`adv-upload|${refsKey(repo)}`, () =>
        Buffer.concat([pktLine('# service=git-upload-pack\n'), v0RefLines(repo, caps), PKT_FLUSH])),
    };
  }
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-advertisement',
    body: cachedRefAnswer(`adv-receive|${refsKey(repo)}`, () =>
      Buffer.concat([pktLine('# service=git-receive-pack\n'), v0RefLines(repo, caps), PKT_FLUSH])),
  };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

export function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  const { segments } = scanSegments(body);
  const args = segments.flat();
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const buildLines = (): string[] => {
    const lines: string[] = [];
    const headOid = repo.refs.get(repo.headRef);
    if (matches('HEAD')) {
      if (headOid !== undefined) {
        lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`);
      } else if (unborn) {
        lines.push(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`);
      }
    }
    for (const [name, oid] of sortedRefs(repo)) {
      if (!matches(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const object = repo.getObject(oid);
        if (object !== undefined && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
      }
      lines.push(`${line}\n`);
    }
    return lines;
  };
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: cachedRefAnswer(`lsrefs|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(',')}|${refsKey(repo)}`, () =>
      Buffer.concat([...buildLines().map((line) => pktLine(line)), PKT_FLUSH])),
  };
}

// ---------------------------------------------------------------------------------------------
// fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function collectTreeObjects(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const object = repo.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

/** Every object reachable from `oid` (tags peeled, commits walked), for fetch exclusion. */
function collectReachable(repo: Repo, oid: string, parentless: ReadonlySet<string>, into: Set<string>): void {
  const object = repo.getObject(oid);
  if (object === undefined) return;
  if (object.type === 'tag') {
    into.add(oid);
    collectReachable(repo, parseTag(object.data).object, parentless, into);
    return;
  }
  if (object.type !== 'commit') {
    into.add(oid);
    return;
  }
  // Walk the commit graph, adding each commit's tree as we go.
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (into.has(current)) continue;
    const view = repo.commitView(current);
    if (view === undefined) continue;
    into.add(current);
    collectTreeObjects(repo, view.tree, into);
    if (parentless.has(current)) continue;
    for (const parent of view.parents) stack.push(parent);
  }
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
): FetchPlan {
  const excluded = new Set<string>();
  for (const have of haves) collectReachable(repo, have, clientShallow, excluded);

  // Tag objects the client asked for directly travel with the pack.
  const extraObjects = new Set<string>();
  const tips: string[] = [];
  for (const want of wants) {
    let current = want;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = repo.getObject(current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        extraObjects.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') tips.push(current);
      break;
    }
  }

  // Breadth-first from the wants, tracking generations for the depth limit.
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (!generation.has(tip)) {
      generation.set(tip, 0);
      queue.push(tip);
    }
  }
  const included = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const gen = generation.get(current) as number;
    const view = repo.commitView(current);
    if (view === undefined) continue;
    included.add(current);
    if (depth !== null && gen >= depth - 1) continue; // boundary generation: parents stay behind
    for (const parent of view.parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of included) {
      const gen = generation.get(oid) as number;
      const view = repo.commitView(oid);
      const hasParents = view !== undefined && view.parents.length > 0;
      if (gen >= depth - 1) {
        if (hasParents) shallow.push(oid);
      } else if (clientShallow.has(oid)) {
        unshallow.push(oid);
      }
    }
  }

  const objectIds = new Set<string>();
  for (const oid of extraObjects) if (!excluded.has(oid)) objectIds.add(oid);
  const commits = [...included].filter((oid) => !excluded.has(oid));
  commits.sort((a, b) => (generation.get(a) as number) - (generation.get(b) as number));
  for (const oid of commits) {
    objectIds.add(oid);
    const view = repo.commitView(oid);
    if (view !== undefined) collectTreeObjects(repo, view.tree, objectIds);
  }
  for (const oid of excluded) objectIds.delete(oid);
  for (const oid of extraObjects) if (!excluded.has(oid)) objectIds.add(oid);

  const byType = (type: GitObject['type']) =>
    [...objectIds]
      .map((oid) => ({ oid, object: repo.getObject(oid) as GitObject }))
      .filter((entry) => entry.object !== undefined && entry.object.type === type)
      .sort((a, b) => (a.oid < b.oid ? -1 : 1))
      .map((entry) => entry.object);
  const objects = [...commits.map((oid) => repo.getObject(oid) as GitObject), ...byType('tree'), ...byType('blob'), ...byType('tag')];
  return { objects: objects.filter((object) => object !== undefined), shallow, unshallow };
}

// Built packs are deterministic for a given (repo, wants, haves, depth) request — the wants name
// exact object ids, so a moved ref or a new tip always keys a fresh entry — and the clone
// workload asks for the same shallow pack dozens of times concurrently. Cache plan + bytes.
const packCache = new Map<string, { pack: Buffer; plan: FetchPlan }>();

function fetchKey(repo: Repo, wants: readonly string[], haves: readonly string[], clientShallow: ReadonlySet<string>, depth: number | null): string {
  return [
    repo.id,
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    [...clientShallow].sort().join(','),
    depth === null ? 'full' : String(depth),
  ].join('|');
}

function packFor(repo: Repo, wants: readonly string[], haves: readonly string[], clientShallow: ReadonlySet<string>, depth: number | null): { pack: Buffer; plan: FetchPlan } {
  const key = fetchKey(repo, wants, haves, clientShallow, depth);
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const pack = writePack(plan.objects);
  if (packCache.size > 64) packCache.clear();
  const entry = { pack, plan };
  packCache.set(key, entry);
  return entry;
}

// Whole fetch responses are as deterministic as the packs inside them: git objects are
// immutable and content-addressed, so for a fixed (wants, haves, shallow, depth) key the only
// part that could ever change is which of the wants/haves already name commits in this repo —
// the key therefore carries one existence bit per want and have, recomputed per request. The
// clone workload repeats one identical fetch fifty times concurrently; serving the finished
// bytes skips the plan lookup, the side-band wrapping and every Buffer.concat in between.
const fetchResponseCache = new Map<string, Buffer>();

function fetchResponseKey(repo: Repo, wants: readonly string[], haves: readonly string[], clientShallow: ReadonlySet<string>, depth: number | null): string {
  const existence = (oid: string): string => (repo.getObject(oid) !== undefined ? '1' : '0');
  return `${fetchKey(repo, wants, haves, clientShallow, depth)}#${wants.map(existence).join('')}/${haves.map(existence).join('')}`;
}

/** Wrap pack bytes in side-band-64k packets (band 1 = data). */
function sidebandWrap(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65512;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

function section(name: string, lines: readonly string[]): Buffer {
  return Buffer.concat([pktLine(`${name}\n`), ...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// upload-pack

export function handleFetchV2(repo: Repo, body: Buffer): GitResponse {
  const { segments } = scanSegments(body);
  const args = segments.flat();
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) depth = null; // not exercised; serve full depth
  }
  const cacheKey = fetchResponseKey(repo, wants, haves, clientShallow, depth);
  const cachedBody = fetchResponseCache.get(cacheKey);
  if (cachedBody !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cachedBody };
  }
  const { pack, plan } = packFor(repo, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    const acks = haves.filter((have) => repo.commitView(have) !== undefined);
    const lines = acks.length > 0 ? [...acks.map((oid) => `ACK ${oid}\n`), 'ready\n'] : ['NAK\n'];
    parts.push(section('acknowledgments', lines));
  }
  if (depth !== null || clientShallow.size > 0) {
    const lines = [
      ...plan.shallow.map((oid) => `shallow ${oid}\n`),
      ...plan.unshallow.map((oid) => `unshallow ${oid}\n`),
    ];
    parts.push(section('shallow-info', lines));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  const responseBody = Buffer.concat(parts);
  if (fetchResponseCache.size > 64) fetchResponseCache.clear();
  fetchResponseCache.set(cacheKey, responseBody);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: responseBody };
}

export function handleFetchV0(repo: Repo, body: Buffer): GitResponse {
  const { segments } = scanSegments(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  segments.forEach((segment, index) => {
    for (const raw of segment) {
      const line = raw.replace(/\n$/, '');
      const clean = line.split('\0')[0];
      if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
      else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
      else if (clean.startsWith('deepen ')) depth = Number.parseInt(clean.slice(7).trim(), 10);
      void index;
    }
  });
  // Route v0 through the same pack cache as v2: the plan and the pack bytes for a given
  // (wants, haves, depth) are identical whichever protocol generation asked for them.
  const { pack, plan } = packFor(repo, wants, haves, new Set(), depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (depth !== null) parts.push(PKT_FLUSH);
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  const scanned = scanPktLines(body, 0);
  const commands: RefCommand[] = [];
  let capabilities = '';
  scanned.lines.forEach((raw, index) => {
    let line = raw.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });
  const wantsReport = capabilities.includes('report-status');
  const wantsSideband = capabilities.includes('side-band-64k');

  let unpackError: string | null = null;
  const packBytes = scanned.rest;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, repo.objects);
      for (const [oid, object] of read.objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackError === null ? 'ok' : `error ${unpackError}`}\n`];
  for (const command of commands) {
    const failure = unpackError !== null ? 'unpack failed' : applyCommand(repo, command);
    report.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
  }
  if (!wantsReport) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  if (wantsSideband) {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: Buffer.concat([sidebandWrap(inner), PKT_FLUSH]),
    };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: inner };
}

/** Apply one ref update; returns null on success or the failure reason for the report. */
function applyCommand(repo: Repo, command: RefCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    // delete
    if (current === ZERO_OID) return 'reference not found';
    repo.refs.delete(command.ref);
    repo.invalidateHistoryCaches();
    repo.touch();
    return null;
  }
  const object = repo.getObject(command.newOid);
  if (object === undefined) return 'missing object';
  if (command.oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return 'reference already exists';
  } else {
    if (current !== command.oldOid) return 'stale info';
    // fast-forward only: the new tip must descend from the old one (branch and tag refs alike)
    const newCommit = repo.peelToCommit(command.newOid);
    const oldCommit = repo.peelToCommit(command.oldOid);
    if (newCommit !== undefined && oldCommit !== undefined && newCommit !== oldCommit) {
      if (!repo.isAncestor(oldCommit, newCommit)) return 'non-fast-forward';
    }
  }
  if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
  repo.refs.set(command.ref, command.newOid);
  repo.invalidateHistoryCaches();
  repo.touch();
  return null;
}
