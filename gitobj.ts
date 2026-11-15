// The git object model, in-process: SHA-1 addressed objects, trees, commits, tags, packfiles.
// Node standard library only (node:crypto for SHA-1, node:zlib for (in)flate). No git binary exists
// in the trial pod, so every byte of the smart-HTTP protocol is produced and consumed here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The object id git computes for `type` + payload: sha1("<type> <size>\0" + payload). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees

export interface TreeEntry {
  readonly mode: string; // "100644", "100755", "120000", "40000" (tree), "160000" (gitlink)
  readonly name: string;
  readonly oid: string;
}

const TYPE_BY_CODE: Readonly<Record<number, GitObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const CODE_BY_TYPE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Parse a tree object's payload into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories sorting as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object payload from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// packfiles

/**
 * Inflate the zlib stream starting at `offset`; returns the payload and the offset just past it.
 * `inflateSync(..., {info: true})` reports how many compressed bytes the stream consumed.
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== resultSize || out.length !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackRead {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
}

/**
 * Read a whole packfile into an object map. Deltas (OFS and REF) are resolved against the pack
 * itself and, for a thin pack, against `external` (the receiver's own store).
 */
export function readPack(pack: Buffer, external?: ReadonlyMap<string, GitObject>): PackRead {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer; // inflated payload (the delta payload, for delta entries)
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base, in git's offset encoding.
      let b = pack[offset];
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    const entry: RawEntry = { offset: start, typeCode, data: inflated.data, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(start, entry);
  }

  const resolved = new Map<string, GitObject>();
  // Resolution is memoised per raw entry: a popular base object is resolved (and hashed) once,
  // however many deltas sit on it, and each entry's own object id is computed exactly once —
  // the previous shape re-hashed every object at the end and re-walked bases per delta.
  const memo = new Map<RawEntry, { object: GitObject; oid: string }>();
  // Built lazily, only if a REF delta actually needs to find its base inside this pack: an
  // oid -> entry index for the pack's plain entries, replacing a linear scan that re-hashed
  // every candidate for every delta.
  let plainByOid: Map<string, RawEntry> | null = null;
  const findPlainByOid = (oid: string): RawEntry | undefined => {
    if (plainByOid === null) {
      plainByOid = new Map();
      for (const candidate of raw) {
        if (candidate.typeCode >= 1 && candidate.typeCode <= 4) {
          plainByOid.set(hashObject(TYPE_BY_CODE[candidate.typeCode], candidate.data), candidate);
        }
      }
    }
    return plainByOid.get(oid);
  };
  const resolveEntry = (entry: RawEntry, depth: number): { object: GitObject; oid: string } => {
    const hit = memo.get(entry);
    if (hit !== undefined) return hit;
    if (depth > 64) throw new Error('delta chain too deep');
    let object: GitObject;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      object = { type: TYPE_BY_CODE[entry.typeCode], data: entry.data };
    } else {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        base = resolveEntry(baseEntry, depth + 1).object;
      } else if (entry.baseOid !== undefined) {
        base = resolved.get(entry.baseOid) ?? external?.get(entry.baseOid);
        if (base === undefined) {
          // The base may sit later in the same pack.
          const baseEntry = findPlainByOid(entry.baseOid);
          if (baseEntry !== undefined) base = resolveEntry(baseEntry, depth + 1).object;
        }
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      }
      if (base === undefined) throw new Error('delta without a base');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    const settled = { object, oid: hashObject(object.type, object.data) };
    memo.set(entry, settled);
    return settled;
  };

  for (const entry of raw) {
    const { object, oid } = resolveEntry(entry, 0);
    resolved.set(oid, object);
  }
  return { objects: resolved, count };
}

/** Write a packfile holding `objects` as plain (undeltified) entries, in the order given. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const code = CODE_BY_TYPE[object.type];
    const size = object.data.length;
    let firstByte = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    const headBytes: number[] = [];
    if (rest > 0) firstByte |= 0x80;
    headBytes.push(firstByte);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktItem =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode a complete pkt-line stream (a request body); throws on malformed framing. */
export function decodePktLines(buffer: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      items.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
      items.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return items;
}
