// Git's object model, wire framing and packfiles, implemented on node:crypto and
// node:zlib only. No git binary is involved anywhere: every object the forge
// stores is a byte buffer whose sha-1 the forge computes itself.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** sha-1 of a buffer, lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha-1 of `<type> <length>\0<bytes>`. Streams the
 * header and the data into the hash instead of concatenating a copy. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** The full on-disk form of an object (header + bytes), for pack entries. */
export function objectBytes(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

// ---------------------------------------------------------------- commits

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface Identity {
  name: string;
  email: string;
  epoch: number;
}

export function identityLine(identity: Identity): string {
  return `${identity.name} <${identity.email}> ${identity.epoch} +0000`;
}

/** Build a commit object's bytes. Headers in git order; message as given. */
export function buildCommit(parts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

/** Parse a commit object's bytes into its headers and message. */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parts: CommitParts = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) parts.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parts.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) parts.author = line.slice(7);
    else if (line.startsWith('committer ')) parts.committer = line.slice(10);
  }
  return parts;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: entries ordered by name, directories as if the name ends in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- tags

export interface TagParts {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(parts: TagParts): Buffer {
  const lines = [
    `object ${parts.object}`,
    `type ${parts.type}`,
    `tag ${parts.tag}`,
    `tagger ${parts.tagger}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parts: TagParts = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) parts.object = line.slice(7).trim();
    else if (line.startsWith('type ')) parts.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) parts.tag = line.slice(4);
    else if (line.startsWith('tagger ')) parts.tagger = line.slice(7);
  }
  return parts;
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line framing a payload (payload must already end in '\n' when it is text). */
export function pktLine(payload: Buffer): Buffer {
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Decode a complete buffer of pkt-lines. Throws on truncation or bad lengths. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header truncated');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('pkt-line has a bad length');
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) throw new Error('pkt-line payload truncated');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Encode a list of text lines / flush / delim markers as pkt-lines. */
export function encodePktLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const chunks: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') chunks.push(pktFlush());
    else if (line === 'delim') chunks.push(pktDelim());
    else chunks.push(pktText(line));
  }
  return Buffer.concat(chunks);
}

/** Encode one sideband packet: band byte (1 = data) + payload, pkt-line framed. */
export function sidebandPacket(band: 1 | 2 | 3, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

// ---------------------------------------------------------------- packfiles

/** Write a packfile of plain (undeltified) objects, with the sha-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  chunks.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  chunks.push(count);
  for (const object of objects) {
    // A pack entry's zlib stream holds the object's data only: the type and
    // size live in the entry header, not in the compressed bytes.
    const compressed = deflateSync(object.data);
    // Object header: type in bits 4-6, size in bits 0-3 then 7-bit groups, MSB-continued.
    const header: number[] = [];
    let size = object.data.length;
    let first = (TYPE_CODE[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    header.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      header.push(byte);
    }
    chunks.push(Buffer.from(header), compressed);
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta (copy/insert ops) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || written !== resultSize) {
    throw new Error('delta result size mismatch');
  }
  return result;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile, resolving OFS/REF deltas against pack-local and supplied bases. */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const readSizeAndType = (): { type: number; size: number } => {
    let byte = pack[offset] as number;
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { type, size };
  };
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { type, size } = readSizeAndType();
    if (type === 6) {
      // OFS-delta: base offset encoded as a variable-length negative offset.
      let byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseEntryOffset = entryOffset - baseOffset;
      const inflated = inflateSync(pack.subarray(offset));
      offset += inflatedConsumed(pack, offset);
      const base = byOffset.get(baseEntryOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      // A delta applies to the base object's content; the result keeps the base type.
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, inflated) };
      objects.set(hashObject(resolved.type, resolved.data), resolved);
      byOffset.set(entryOffset, resolved);
      deltaCount += 1;
      void size;
    } else if (type === 7) {
      // REF-delta: 20-byte base oid follows the header.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset));
      offset += inflatedConsumed(pack, offset);
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error('ref-delta base is unknown');
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, inflated) };
      objects.set(hashObject(resolved.type, resolved.data), resolved);
      byOffset.set(entryOffset, resolved);
      deltaCount += 1;
      void size;
    } else {
      const objType = CODE_TYPE[type];
      if (objType === undefined) throw new Error(`unknown pack object type ${type}`);
      const inflated = inflateSync(pack.subarray(offset));
      offset += inflatedConsumed(pack, offset);
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const object: GitObject = { type: objType, data: inflated };
      objects.set(hashObject(objType, inflated), object);
      byOffset.set(entryOffset, object);
    }
  }
  return { objects, deltaCount };
}

/**
 * How many bytes of `pack` from `offset` the last inflate consumed. node:zlib
 * does not report the consumed length, so re-inflate with a probe: inflate the
 * smallest prefix that succeeds, growing by the remaining length. Packs here
 * are small (a few KB), so a linear probe is cheap and exact.
 */
function inflatedConsumed(pack: Buffer, offset: number): number {
  const rest = pack.subarray(offset);
  let low = 1;
  let high = rest.length;
  // Binary search the shortest prefix that inflates cleanly.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(rest.subarray(0, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

/**
 * Inflate one zlib stream taken from the front of `buf` and report how many
 * input bytes that stream consumed. `inflateSync` with `{ info: true }`
 * returns the engine alongside the output, and the engine's `bytesWritten`
 * is exactly the number of input bytes the stream consumed, which is what a
 * pack reader needs to find the next entry. One synchronous inflate per
 * object, no binary search, no stream machinery.
 */
function inflateOneSync(buf: Buffer): { data: Buffer; consumed: number } {
  const result = inflateSync(buf, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/**
 * Fast synchronous pack reader, mirroring readPack but with one inflate per
 * object via inflateOneSync. Throws on any surprise (unknown type, size
 * mismatch, consumed length outside the pack, leftover bytes that are not
 * the 20-byte pack trailer) so the caller can fall back to slower readers.
 */
function readPackFast(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const readSizeAndType = (): { type: number; size: number } => {
    let byte = pack[offset] as number;
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { type, size };
  };
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { type, size } = readSizeAndType();
    if (type === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseEntryOffset = entryOffset - baseOffset;
      const { data: inflated, consumed } = inflateOneSync(pack.subarray(offset));
      if (consumed <= 0 || offset + consumed > pack.length) throw new Error('bad delta stream length');
      offset += consumed;
      const base = byOffset.get(baseEntryOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, inflated) };
      objects.set(hashObject(resolved.type, resolved.data), resolved);
      byOffset.set(entryOffset, resolved);
      deltaCount += 1;
      void size;
    } else if (type === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: inflated, consumed } = inflateOneSync(pack.subarray(offset));
      if (consumed <= 0 || offset + consumed > pack.length) throw new Error('bad delta stream length');
      offset += consumed;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error('ref-delta base is unknown');
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, inflated) };
      objects.set(hashObject(resolved.type, resolved.data), resolved);
      byOffset.set(entryOffset, resolved);
      deltaCount += 1;
      void size;
    } else {
      const objType = CODE_TYPE[type];
      if (objType === undefined) throw new Error(`unknown pack object type ${type}`);
      const { data: inflated, consumed } = inflateOneSync(pack.subarray(offset));
      if (consumed <= 0 || offset + consumed > pack.length) throw new Error('bad object stream length');
      offset += consumed;
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const object: GitObject = { type: objType, data: inflated };
      objects.set(hashObject(objType, inflated), object);
      byOffset.set(entryOffset, object);
    }
  }
  // Whatever is left must be nothing or the 20-byte pack trailer.
  const remainder = pack.length - offset;
  if (remainder !== 0 && remainder !== 20) throw new Error('pack has unexpected trailing bytes');
  return { objects, deltaCount };
}

/**
 * Inflate one zlib stream taken from the front of `buf` and report how many
 * input bytes that stream consumed. A node:zlib Inflate stream stops at the
 * end of the first zlib stream it sees and ignores everything after it, and
 * once it ends its `bytesWritten` is exactly the number of input bytes the
 * stream consumed, which is what a pack reader needs to find the next entry.
 * This is one inflate per object instead of the log2(n) inflates a binary
 * search needs, so large packs parse several times faster.
 */
function inflateOne(buf: Buffer): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.write(buf);
    stream.end();
  });
}

/**
 * Async pack reader: same result as readPack. Tries the fast synchronous
 * one-inflate-per-object reader first, then the streaming reader, then the
 * binary-search reader, so a runtime whose zlib reports consumption
 * differently still parses packs correctly, just slower.
 */
export async function readPackAsync(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Promise<PackRead> {
  try {
    return readPackFast(pack, resolveBase);
  } catch {
    // Fall through to the streaming reader, then the binary-search reader.
  }
  try {
    return await readPackStream(pack, resolveBase);
  } catch {
    return readPack(pack, resolveBase);
  }
}

async function readPackStream(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Promise<PackRead> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const readSizeAndType = (): { type: number; size: number } => {
    let byte = pack[offset] as number;
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { type, size };
  };
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { type, size } = readSizeAndType();
    if (type === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseEntryOffset = entryOffset - baseOffset;
      const { data: inflated, consumed } = await inflateOne(pack.subarray(offset));
      if (consumed <= 0 || offset + consumed > pack.length) throw new Error('bad delta stream length');
      offset += consumed;
      const base = byOffset.get(baseEntryOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, inflated) };
      objects.set(hashObject(resolved.type, resolved.data), resolved);
      byOffset.set(entryOffset, resolved);
      deltaCount += 1;
      void size;
    } else if (type === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: inflated, consumed } = await inflateOne(pack.subarray(offset));
      if (consumed <= 0 || offset + consumed > pack.length) throw new Error('bad delta stream length');
      offset += consumed;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error('ref-delta base is unknown');
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, inflated) };
      objects.set(hashObject(resolved.type, resolved.data), resolved);
      byOffset.set(entryOffset, resolved);
      deltaCount += 1;
      void size;
    } else {
      const objType = CODE_TYPE[type];
      if (objType === undefined) throw new Error(`unknown pack object type ${type}`);
      const { data: inflated, consumed } = await inflateOne(pack.subarray(offset));
      if (consumed <= 0 || offset + consumed > pack.length) throw new Error('bad object stream length');
      offset += consumed;
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const object: GitObject = { type: objType, data: inflated };
      objects.set(hashObject(objType, inflated), object);
      byOffset.set(entryOffset, object);
    }
  }
  if (offset > pack.length) throw new Error('pack overrun');
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- traversal

/** Minimal object access the traversal helpers need. */
export interface ObjectStore {
  get(oid: string): GitObject | undefined;
}

/** Flatten a tree into path -> blob oid, following subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, string> {
  const flat = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else flat.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return flat;
}

/** The closure of a tree: the tree itself, every subtree and every blob. */
export function treeClosure(store: ObjectStore, treeOid: string, out: Set<string>): void {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  out.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') treeClosure(store, entry.oid, out);
    else out.add(entry.oid);
  }
}

/** Commit history from a tip, newest first (depth-first pre-order, parents in order). */
export function commitHistory(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return order;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the nearest common ancestor (BFS from both sides). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, dist] = queueA.shift() as [string, number];
    if (distA.has(oid)) continue;
    distA.set(oid, dist);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, dist] = queueB.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const distFromA = distA.get(oid);
    if (distFromA !== undefined) {
      const score = distFromA + dist;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
  }
  return best;
}

// ---------------------------------------------------------------- fetch selection

export interface FetchSelection {
  /** Oids to put in the pack (commits, trees, blobs, tags as applicable). */
  objects: string[];
  /** New shallow boundaries to report (commits at the depth edge). */
  shallow: string[];
  /** Old boundaries that are now fully included. */
  unshallow: string[];
}

/**
 * Which objects a fetch must send. `wants` are the tips the client asked for,
 * `haves` the commits it already holds, `oldBoundaries` its current shallow
 * boundaries, `depth` the requested depth (undefined = full history).
 *
 * A held commit that is a shallow boundary contributes only itself plus its
 * full tree closure; a held commit that is not a boundary contributes its
 * whole reachable closure. A wanted commit contributes its commits up to the
 * depth edge plus the tree closure of every included commit.
 */
export function selectFetchObjects(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  oldBoundaries: string[],
  depth: number | undefined,
  filter: string | undefined,
): FetchSelection {
  const held = new Set<string>();
  const boundarySet = new Set(oldBoundaries);
  for (const have of haves) {
    const object = store.get(have);
    if (object === undefined || object.type !== 'commit') continue;
    if (boundarySet.has(have)) {
      held.add(have);
      treeClosure(store, parseCommit(object.data).tree, held);
    } else {
      for (const commit of commitHistory(store, have)) {
        held.add(commit);
        const commitObject = store.get(commit);
        if (commitObject !== undefined && commitObject.type === 'commit') {
          treeClosure(store, parseCommit(commitObject.data).tree, held);
        }
      }
    }
  }

  const wanted = new Set<string>();
  const newBoundaries = new Set<string>();
  // Breadth-first over commits from the wants, tracking distance from the want.
  // A tag want contributes the tag object itself and continues at its target.
  // An index cursor, not shift(): shift() is O(n) per pop and this queue can
  // hold a whole history.
  const queue: Array<[string, number]> = [];
  let queueHead = 0;
  const seen = new Set<string>();
  for (const want of wants) queue.push([want, 0]);
  while (queueHead < queue.length) {
    const [oid, dist] = queue[queueHead] as [string, number];
    queueHead += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wanted.add(oid);
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) queue.push([match[1] as string, dist]);
      continue;
    }
    if (object.type !== 'commit') continue;
    wanted.add(oid);
    treeClosure(store, parseCommit(object.data).tree, wanted);
    if (depth !== undefined && dist === depth - 1) {
      newBoundaries.add(oid);
      continue;
    }
    for (const parent of parseCommit(object.data).parents) queue.push([parent, dist + 1]);
  }

  const unshallow = oldBoundaries.filter(
    (boundary) => !newBoundaries.has(boundary) && wanted.has(boundary),
  );
  const shallow = [...newBoundaries].filter((oid) => !held.has(oid));

  let objects = [...wanted].filter((oid) => !held.has(oid));
  if (filter === 'blob:none') {
    objects = objects.filter((oid) => store.get(oid)?.type !== 'blob');
  } else if (filter === 'tree:0') {
    objects = objects.filter((oid) => store.get(oid)?.type === 'commit');
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- merge and diff

export interface MergeResult {
  /** The merged flat tree: path -> blob oid. */
  tree: Map<string, string>;
  /** True when both sides changed the same path differently. */
  conflict: boolean;
}

/**
 * Three-way merge of flat trees. A path is conflicted when both sides changed
 * it against the base and the two results differ. Deletions count as changes.
 */
export function threeWayMerge(
  base: Map<string, string>,
  ours: Map<string, string>,
  theirs: Map<string, string>,
): MergeResult {
  const tree = new Map<string, string>();
  let conflict = false;
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o === t) {
      if (o !== undefined) tree.set(path, o);
    } else if (b === o) {
      if (t !== undefined) tree.set(path, t);
    } else if (b === t) {
      if (o !== undefined) tree.set(path, o);
    } else {
      conflict = true;
    }
  }
  return { tree, conflict };
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | undefined;
  newOid: string | undefined;
}

/** The file-level diff between two flat trees. */
export function diffTrees(base: Map<string, string>, head: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) changes.push({ path, status: 'added', oldOid: undefined, newOid: h });
    else if (h === undefined) changes.push({ path, status: 'removed', oldOid: b, newOid: undefined });
    else changes.push({ path, status: 'modified', oldOid: b, newOid: h });
  }
  changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return changes;
}

/** Count the lines of a buffer (a trailing newline does not add an empty line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === 0x0a) count += 1;
  }
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}
