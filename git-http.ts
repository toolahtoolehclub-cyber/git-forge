// Git smart HTTP: info/refs advertisements, upload-pack (v2 and v0) and
// receive-pack (v0). The wire format follows the git protocol exactly as the
// suite's client reads it: pkt-line framing, section delimiters, sideband
// pack delivery, and report-status replies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  pktText,
  readPack,
  readPackAsync,
  selectFetchObjects,
  sidebandPacket,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjectStore,
} from './git.ts';
import { type Repo, type Store } from './store.ts';
import { checkAuth, sendBytes, sendError } from './http-util.ts';

const AGENT = 'git-forge/1.0';
const UPLOAD_V0_CAPS =
  'side-band-64k shallow thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/main agent=git-forge/1.0';
const RECEIVE_V0_CAPS =
  'report-status side-band-64k ofs-delta delete-refs symref=HEAD:refs/heads/main agent=git-forge/1.0';
const PACK_CHUNK = 65515;

/**
 * Built packs, keyed by repo id + the ordered object list. A pack is a pure
 * function of that list (objects are immutable and content-addressed, and
 * deflate is deterministic), so the 50 concurrent shallow clones of one
 * repository build the pack once and serve it 49 times from cache. Bounded;
 * the trial only ever fetches a handful of distinct packs.
 */
const packCache = new Map<string, Buffer>();

function packFor(repo: Repo, oids: string[], objects: GitObject[]): Buffer {
  const key = `${repo.id}:${oids.join(',')}`;
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(objects);
  if (packCache.size >= 512) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then lexical order; tags peel to commits. */
export function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) {
    lines.push({ oid: tip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const tag = parseTag(object.data);
      lines.push({ oid, name, peeled: tag.object });
    } else {
      lines.push({ oid, name });
    }
  }
  return lines;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const chunks: Buffer[] = [pktText(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  const hasTip = refs.some((ref) => ref.name !== 'HEAD' && ref.oid !== ZERO_OID);
  if (!hasTip) {
    chunks.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(chunks);
  }
  let first = true;
  for (const ref of refs) {
    const line = first
      ? `${ref.oid} ${ref.name}\0${caps}\n`
      : `${ref.oid} ${ref.name}\n`;
    chunks.push(pktText(line));
    if (ref.peeled !== undefined) chunks.push(pktText(`${ref.peeled} ${ref.name}^{}\n`));
    first = false;
  }
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The v2 advertisement never changes: build it once, share the bytes. */
const V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done filter\n',
  'object-format=sha1\n',
  'flush',
]);

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  repo: Repo,
  service: string,
  isV2: boolean,
  res: ServerResponse,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, 'unknown service');
    return;
  }
  // receive-pack is v0 only: it always answers v0, whatever the header said.
  const body =
    isV2 && service === 'git-upload-pack'
      ? v2Advertisement()
      : v0Advertisement(service as 'git-upload-pack' | 'git-receive-pack', repo);
  sendBytes(res, 200, `application/x-${service}-advertisement`, body);
}

/** Parse ls-refs request lines into options. */
function parseLsRefs(packets: Array<{ kind: string; payload?: Buffer }>): {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
} {
  const options = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') options.peel = true;
    else if (line === 'symrefs') options.symrefs = true;
    else if (line === 'unborn') options.unborn = true;
    else if (line.startsWith('ref-prefix ')) options.prefixes.push(line.slice('ref-prefix '.length));
  }
  return options;
}

/** POST git-upload-pack, protocol v2: ls-refs or fetch. */
function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else args.push(line);
  }
  if (command === 'ls-refs') {
    const options = parseLsRefs(packets);
    const refs = listRefs(repo);
    const out: Buffer[] = [];
    for (const ref of refs) {
      if (options.prefixes.length > 0 && !options.prefixes.some((prefix) => ref.name.startsWith(prefix))) {
        continue;
      }
      if (ref.unborn === true) {
        if (options.unborn) {
          out.push(pktText(`unborn HEAD symref-target:${ref.symrefTarget ?? `refs/heads/${repo.defaultBranch}`}\n`));
        }
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (options.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      if (options.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(pktText(`${line}\n`));
    }
    out.push(pktFlush());
    sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(repo, args, res);
    return;
  }
  sendError(res, 400, `unknown command ${command}`);
}

function handleFetchV2(repo: Repo, args: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let filter: string | undefined;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
  }
  const objectStore: ObjectStore = { get: (oid) => repo.objects.get(oid) };
  const selection = selectFetchObjects(objectStore, wants, haves, shallow, depth, filter);
  const objects: GitObject[] = [];
  for (const oid of selection.objects) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const out: Buffer[] = [pktText('acknowledgments\n'), pktText('NAK\n'), pktDelim()];
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    out.push(pktText('shallow-info\n'));
    for (const oid of selection.shallow) out.push(pktText(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) out.push(pktText(`unshallow ${oid}\n`));
    out.push(pktDelim());
  }
  if (objects.length > 0) {
    out.push(pktText('packfile\n'));
    const pack = packFor(repo, selection.objects, objects);
    for (let offset = 0; offset < pack.length; offset += PACK_CHUNK) {
      out.push(sidebandPacket(1, pack.subarray(offset, Math.min(pack.length, offset + PACK_CHUNK))));
    }
  }
  out.push(pktFlush());
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

/** POST git-upload-pack, protocol v0: want/have negotiation + pack. */
function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const objectStore: ObjectStore = { get: (oid) => repo.objects.get(oid) };
  const selection = selectFetchObjects(objectStore, wants, haves, shallow, depth, undefined);
  const objects: GitObject[] = [];
  for (const oid of selection.objects) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const out: Buffer[] = [pktText('NAK\n')];
  for (const oid of selection.shallow) out.push(pktText(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) out.push(pktText(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    const pack = packFor(repo, selection.objects, objects);
    for (let offset = 0; offset < pack.length; offset += PACK_CHUNK) {
      out.push(sidebandPacket(1, pack.subarray(offset, Math.min(pack.length, offset + PACK_CHUNK))));
    }
  }
  out.push(pktFlush());
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

/** POST git-upload-pack: dispatch on the Git-Protocol header. */
export function handleUploadPack(
  repo: Repo,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  try {
    if (isV2) handleUploadPackV2(repo, body, res);
    else handleUploadPackV0(repo, body, res);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'bad upload-pack request');
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Build the report-status body: pkt-lined lines inside one band-1 packet. */
function pushReport(unpackOk: boolean, results: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = encodePktLines(lines);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += PACK_CHUNK) {
    chunks.push(sidebandPacket(1, report.subarray(offset, Math.min(report.length, offset + PACK_CHUNK))));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** POST git-receive-pack: command list + pack, fast-forward only, per-ref report. */
export async function handleReceivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  try {
    const commands: PushCommand[] = [];
    let packStart = -1;
    let offset = 0;
    // Walk the raw bytes: command lines are pkt-lines up to the first flush;
    // everything after it is the pack.
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated push request');
      const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(length) || length < 0) throw new Error('bad pkt-line in push request');
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length === 1) {
        offset += 4;
        continue;
      }
      if (offset + length > body.length) throw new Error('truncated push request');
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      const line = payload.replace(/\n$/, '');
      if (line === '') continue;
      const nul = line.indexOf('\0');
      const head = nul < 0 ? line : line.slice(0, nul);
      const parts = head.split(' ');
      if (parts.length < 3) throw new Error('bad push command line');
      commands.push({
        oldOid: parts[0] as string,
        newOid: parts[1] as string,
        ref: parts.slice(2).join(' '),
      });
    }
    if (commands.length === 0) throw new Error('push has no commands');
    if (packStart < 0) packStart = offset;

    // Parse and stage the pack before touching any ref, so a bad pack changes nothing.
    const packBytes = body.subarray(packStart);
    const staged = new Map<string, GitObject>();
    if (packBytes.length > 0) {
      const read = await readPackAsync(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) staged.set(oid, object);
    }
    const objectStore: ObjectStore = {
      get: (oid) => staged.get(oid) ?? repo.objects.get(oid),
    };

    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = objectStore.get(command.newOid);
      if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      } else {
        if (current === undefined || current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (!isAncestor(objectStore, command.oldOid, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      // Commit the staged objects, then move the ref.
      for (const [oid, object] of staged) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    // Any staged object from a rejected push still lands in the store (git
    // keeps unpacked objects); only refs are guarded.
    for (const [oid, object] of staged) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    sendBytes(res, 200, 'application/x-git-receive-pack-result', pushReport(true, results));
  } catch {
    // A malformed push must never crash the server or move a ref.
    sendBytes(res, 200, 'application/x-git-receive-pack-result', pushReport(false, []));
  }
}
