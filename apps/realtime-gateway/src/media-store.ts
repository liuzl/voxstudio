import { Database } from "bun:sqlite";
import { encodePcm16, wavHeader } from "@voxstudio/audio";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { appendFile, chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FinalizedInputAudio } from "@voxstudio/conversation";

const SCHEMA_VERSION = 1;
const DEFAULT_PENDING_BYTES = 32 * 1024 * 1024;

export type ConversationMediaDirection = "input" | "output";
export type ConversationMediaState = "pending" | "ready" | "missing" | "truncated";
export type ConversationMediaDelivery = "sent" | "playback_acknowledged" | "interrupted" | "superseded";

export interface ConversationMediaDescriptor {
  id: string;
  sessionId: string;
  turnId: string;
  revision: number;
  direction: ConversationMediaDirection;
  state: ConversationMediaState;
  delivery: ConversationMediaDelivery | null;
  sampleRate: number;
  channels: 1;
  sampleCount: number;
  durationMs: number;
  bytes: number;
  sha256: string | null;
  createdAt: number;
  errorCode: string | null;
}

export interface ConversationMediaStoreOptions {
  maxBytes?: number;
  maxPendingBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Oldest completed conversations which may be removed to make room. */
  evictionCandidates?: (protectedOwner: string, protectedSessionId: string) => Array<{ owner: string; sessionId: string }>;
  /** Atomically hide a candidate before its bytes are removed. */
  beginEviction?: (owner: string, sessionId: string) => boolean;
  /** Remove the hidden Conversation row after its media reached a terminal state. */
  finishEviction?: (owner: string, sessionId: string) => void;
  /** Test seam and host-specific deletion adapter. Defaults to force-removing one file. */
  removeFile?: (path: string) => Promise<void>;
}

export interface OutputMediaRecorder {
  write(samples: Float32Array, sampleRate: number): void;
  finalize(delivery: ConversationMediaDelivery): void;
}

interface MediaRow {
  id: string;
  session_id: string;
  turn_id: string;
  revision: number;
  direction: ConversationMediaDirection;
  state: ConversationMediaState;
  delivery: ConversationMediaDelivery | null;
  sample_rate: number;
  channels: number;
  sample_count: number;
  duration_ms: number;
  bytes: number;
  created_at: number;
  error_code: string | null;
  storage_key: string | null;
  sha256: string | null;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Owner-scoped conversation audio. SQLite owns discoverability and state; private WAV
 * files own bytes. Every filesystem mutation runs behind one bounded observer queue so
 * the realtime session never awaits disk I/O and deletion remains ordered with writes.
 */
export class ConversationMediaStore {
  readonly maxBytes: number | null;
  private readonly db: Database;
  private readonly mediaDir: string;
  private readonly tmpDir: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxPendingBytes: number;
  private readonly evictionCandidates: ConversationMediaStoreOptions["evictionCandidates"];
  private readonly beginEviction: ConversationMediaStoreOptions["beginEviction"];
  private readonly finishEviction: ConversationMediaStoreOptions["finishEviction"];
  private readonly removeFile: (path: string) => Promise<void>;
  /** Bytes copied from realtime callbacks and not yet consumed by the file observer. */
  private queuedBytes = 0;
  /** Bytes promised to pending assets; remains charged until finalize or failure. */
  private reservedBytes = 0;
  /** Ready bytes cached off the realtime path; mutations are serialized by `tail`. */
  private readyBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(readonly dir: string, options: ConversationMediaStoreOptions = {}) {
    this.maxBytes = positiveInteger(options.maxBytes, "trace max bytes") ?? null;
    this.maxPendingBytes = positiveInteger(options.maxPendingBytes, "media max pending bytes") ?? DEFAULT_PENDING_BYTES;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.evictionCandidates = options.evictionCandidates;
    this.beginEviction = options.beginEviction;
    this.finishEviction = options.finishEviction;
    this.removeFile = options.removeFile ?? (path => rm(path, { force: true }));
    this.mediaDir = join(dir, "media");
    this.tmpDir = join(dir, "media-tmp");
    for (const path of [dir, this.mediaDir, this.tmpDir]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    const databasePath = join(dir, "media.db");
    this.db = new Database(databasePath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS conversation_media (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'missing', 'truncated')),
      delivery TEXT CHECK (delivery IN ('sent', 'playback_acknowledged', 'interrupted', 'superseded')),
      sample_rate INTEGER NOT NULL,
      channels INTEGER NOT NULL DEFAULT 1,
      sample_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      error_code TEXT,
      storage_key TEXT,
      sha256 TEXT,
      UNIQUE (owner_user_id, session_id, turn_id, revision, direction)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS conversation_media_owner_session ON conversation_media (owner_user_id, session_id, created_at, id)");
    this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.reconcile();
    this.readyBytes = this.totalBytesFromDatabase();
  }

  private reconcile(): void {
    for (const entry of readdirSync(this.tmpDir, { withFileTypes: true })) {
      if (entry.isFile()) rmSync(join(this.tmpDir, entry.name), { force: true });
    }
    this.db.run("UPDATE conversation_media SET state = 'missing', error_code = 'recording_interrupted', storage_key = NULL WHERE state = 'pending'");
    for (const row of this.db.query<{ id: string; storage_key: string | null }, []>(
      "SELECT id, storage_key FROM conversation_media WHERE state = 'ready'",
    ).all()) {
      if (row.storage_key === null || !existsSync(join(this.mediaDir, row.storage_key))) {
        this.db.run("UPDATE conversation_media SET state = 'missing', error_code = 'file_missing', storage_key = NULL WHERE id = ?", [row.id]);
      }
    }
    const referenced = new Set(this.db.query<{ storage_key: string }, []>(
      "SELECT storage_key FROM conversation_media WHERE storage_key IS NOT NULL",
    ).all().map(row => row.storage_key));
    const walk = (root: string): void => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) walk(path);
        else {
          const key = path.slice(this.mediaDir.length + 1);
          if (!referenced.has(key)) rmSync(path, { force: true });
        }
      }
    };
    walk(this.mediaDir);
  }

  private totalBytesFromDatabase(): number {
    return this.db.query<{ total: number | null }, []>(
      "SELECT SUM(bytes) AS total FROM conversation_media WHERE state = 'ready'",
    ).get()?.total ?? 0;
  }

  bytesUsed(): number { return this.readyBytes; }

  sessionBytes(owner: string, sessionId: string): number {
    return this.db.query<{ total: number | null }, [string, string]>(
      "SELECT SUM(bytes) AS total FROM conversation_media WHERE owner_user_id = ? AND session_id = ? AND state = 'ready'",
    ).get(owner, sessionId)?.total ?? 0;
  }

  /** Startup repair for a cross-database commit that never reached the Conversation Store. */
  removeUnknownSessions(known: ReadonlySet<string>): void {
    const sessions = this.db.query<{ owner_user_id: string; session_id: string }, []>(
      "SELECT DISTINCT owner_user_id, session_id FROM conversation_media",
    ).all();
    for (const session of sessions) {
      if (known.has(`${session.owner_user_id}\0${session.session_id}`)) continue;
      const files = this.db.query<{ storage_key: string }, [string, string]>(
        "SELECT storage_key FROM conversation_media WHERE owner_user_id = ? AND session_id = ? AND storage_key IS NOT NULL",
      ).all(session.owner_user_id, session.session_id);
      for (const file of files) rmSync(join(this.mediaDir, file.storage_key), { force: true });
      this.db.run("DELETE FROM conversation_media WHERE owner_user_id = ? AND session_id = ?", [session.owner_user_id, session.session_id]);
    }
    this.readyBytes = this.totalBytesFromDatabase();
  }

  private descriptor(row: MediaRow): ConversationMediaDescriptor {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      revision: row.revision,
      direction: row.direction,
      state: row.state,
      delivery: row.delivery,
      sampleRate: row.sample_rate,
      channels: 1,
      sampleCount: row.sample_count,
      durationMs: row.duration_ms,
      bytes: row.bytes,
      sha256: row.sha256,
      createdAt: row.created_at,
      errorCode: row.error_code,
    };
  }

  private storageKey(owner: string, id: string): string {
    return join(createHash("sha256").update(owner).digest("hex"), id.slice(0, 2), `${id}.wav`);
  }

  private reserve(bytes: number): boolean {
    if (this.queuedBytes + bytes > this.maxPendingBytes) return false;
    this.queuedBytes += bytes;
    this.reservedBytes += bytes;
    return true;
  }

  private consumeQueued(bytes: number): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
  }

  private releaseReservation(bytes: number): void {
    this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
  }

  private enqueue(label: string, operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(error => {
      this.log(`media: ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;
  }

  private async removeSessionNow(owner: string, sessionId: string): Promise<void> {
    const rows = this.db.query<{ storage_key: string | null; bytes: number; state: ConversationMediaState }, [string, string]>(
      "SELECT storage_key, bytes, state FROM conversation_media WHERE owner_user_id = ? AND session_id = ?",
    ).all(owner, sessionId);
    await Promise.all(rows.flatMap(row => row.storage_key === null
      ? []
      : [this.removeFile(join(this.mediaDir, row.storage_key))]));
    this.db.run("DELETE FROM conversation_media WHERE owner_user_id = ? AND session_id = ?", [owner, sessionId]);
    this.readyBytes = Math.max(0, this.readyBytes - rows.reduce(
      (total, row) => total + (row.state === "ready" ? row.bytes : 0), 0,
    ));
  }

  /** Called only from the serialized observer queue, never from a media callback. */
  private async ensureCapacity(owner: string, sessionId: string): Promise<boolean> {
    if (this.maxBytes === null || this.readyBytes + this.reservedBytes <= this.maxBytes) return true;
    for (const candidate of this.evictionCandidates?.(owner, sessionId) ?? []) {
      if (this.readyBytes + this.reservedBytes <= this.maxBytes) return true;
      if (this.sessionBytes(candidate.owner, candidate.sessionId) === 0) continue;
      if (this.beginEviction?.(candidate.owner, candidate.sessionId) !== true) continue;
      try {
        await this.removeSessionNow(candidate.owner, candidate.sessionId);
        this.finishEviction?.(candidate.owner, candidate.sessionId);
      } catch (error) {
        // The durable deleting marker remains. Conversation maintenance retries it; the
        // current recording fails closed instead of exceeding the byte ceiling.
        this.log(`media: quota eviction ${candidate.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    return this.readyBytes + this.reservedBytes <= this.maxBytes;
  }

  retainInput(owner: string, utterance: FinalizedInputAudio): void {
    if (this.closing) return;
    const id = randomUUID();
    const bytes = new Uint8Array(utterance.wav);
    const reserved = this.reserve(bytes.byteLength);
    const createdAt = this.now();
    const storageKey = this.storageKey(owner, id);
    const target = join(this.mediaDir, storageKey);
    const temporary = join(this.tmpDir, `${id}.wav.tmp`);
    this.enqueue(`input ${id}`, async () => {
      this.db.run(`INSERT OR IGNORE INTO conversation_media (
        id, owner_user_id, session_id, turn_id, revision, direction, state,
        sample_rate, channels, sample_count, duration_ms, bytes, created_at, error_code
      ) VALUES (?, ?, ?, ?, ?, 'input', ?, ?, 1, ?, ?, 0, ?, ?)`, [
        id, owner, utterance.sessionId, utterance.turnId, utterance.revision,
        reserved ? "pending" : "missing", utterance.sampleRate,
        Math.max(0, Math.floor((bytes.byteLength - 44) / 2)),
        Math.max(0, Math.round((bytes.byteLength - 44) / 2 * 1_000 / utterance.sampleRate)),
        createdAt, reserved ? null : "quota_or_backpressure",
      ]);
      if (!reserved) return;
      try {
        if (!(await this.ensureCapacity(owner, utterance.sessionId))) {
          this.db.run("UPDATE conversation_media SET state = 'missing', error_code = 'quota_or_backpressure' WHERE id = ?", [id]);
          return;
        }
        await writeFile(temporary, bytes, { mode: 0o600 });
        // Windows requires write access for FlushFileBuffers; a read-only handle makes
        // Bun's FileHandle.sync() fail even though the preceding write succeeded.
        await open(temporary, "r+").then(async handle => { try { await handle.sync(); } finally { await handle.close(); } });
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rename(temporary, target);
        await chmod(target, 0o600);
        const sha256 = await sha256File(target);
        this.db.run(`UPDATE conversation_media SET state = 'ready', bytes = ?, storage_key = ?, sha256 = ?, error_code = NULL
          WHERE id = ? AND state = 'pending'`, [bytes.byteLength, storageKey, sha256, id]);
        if (this.db.query<{ state: string }, [string]>("SELECT state FROM conversation_media WHERE id = ?").get(id)?.state === "ready") {
          this.readyBytes += bytes.byteLength;
        } else {
          await rm(target, { force: true });
        }
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        await rm(target, { force: true }).catch(() => {});
        this.db.run("UPDATE conversation_media SET state = 'missing', error_code = 'io_failed', storage_key = NULL WHERE id = ?", [id]);
        throw error;
      } finally {
        this.consumeQueued(bytes.byteLength);
        this.releaseReservation(bytes.byteLength);
      }
    });
  }

  createOutputRecorder(owner: string, sessionId: string, turnId: string, revision: number): OutputMediaRecorder {
    const id = randomUUID();
    const createdAt = this.now();
    let sampleRate: number | undefined;
    let sampleCount = 0;
    let acceptedBytes = 0;
    let headerReserved = false;
    let finalized = false;
    let state: ConversationMediaState = "pending";
    let initialized = false;
    const storageKey = this.storageKey(owner, id);
    const target = join(this.mediaDir, storageKey);
    const temporary = join(this.tmpDir, `${id}.wav.tmp`);

    const ensureRow = (rate: number): void => {
      if (initialized) return;
      initialized = true;
      sampleRate = rate;
      headerReserved = this.reserve(44);
      if (!headerReserved) state = "truncated";
      this.enqueue(`output ${id} initialize`, async () => {
        this.db.run(`INSERT OR IGNORE INTO conversation_media (
          id, owner_user_id, session_id, turn_id, revision, direction, state,
          sample_rate, channels, sample_count, duration_ms, bytes, created_at, error_code
        ) VALUES (?, ?, ?, ?, ?, 'output', ?, ?, 1, 0, 0, 0, ?, ?)`,
        [id, owner, sessionId, turnId, revision, state, rate, createdAt,
          headerReserved ? null : "quota_or_backpressure"]);
        if (!headerReserved) return;
        if (state !== "pending") {
          this.consumeQueued(44);
          return;
        }
        try {
          if (!(await this.ensureCapacity(owner, sessionId))) { fail("quota_or_backpressure"); return; }
          await writeFile(temporary, wavHeader(rate, 0), { mode: 0o600 });
        } catch (error) {
          fail("io_failed");
          this.db.run("UPDATE conversation_media SET state = 'truncated', error_code = ? WHERE id = ?", ["io_failed", id]);
          throw error;
        } finally { this.consumeQueued(44); }
      });
    };

    const fail = (errorCode: string): void => {
      if (state !== "pending") return;
      state = "truncated";
      this.enqueue(`output ${id} fail`, async () => {
        this.db.run("UPDATE conversation_media SET state = 'truncated', error_code = ? WHERE id = ?", [errorCode, id]);
      });
    };

    return {
      write: (samples, rate) => {
        if (this.closing || finalized || samples.length === 0 || state !== "pending") return;
        if (!Number.isSafeInteger(rate) || rate <= 0) { fail("invalid_sample_rate"); return; }
        ensureRow(rate);
        if (sampleRate !== rate) { fail("sample_rate_changed"); return; }
        const retainedSamples = new Float32Array(samples);
        const pcmBytes = retainedSamples.byteLength / 2;
        if (!this.reserve(pcmBytes)) { fail("quota_or_backpressure"); return; }
        acceptedBytes += pcmBytes;
        sampleCount += samples.length;
        this.enqueue(`output ${id} frame`, async () => {
          try {
            if (state !== "pending") return;
            if (!(await this.ensureCapacity(owner, sessionId))) { fail("quota_or_backpressure"); return; }
            await appendFile(temporary, encodePcm16(retainedSamples));
          } catch (error) {
            fail("io_failed");
            throw error;
          } finally { this.consumeQueued(pcmBytes); }
        });
      },
      finalize: delivery => {
        if (finalized) return;
        finalized = true;
        if (!initialized) return;
        const rate = sampleRate as number;
        this.enqueue(`output ${id} finalize`, async () => {
          try {
            if (state !== "pending") {
              this.db.run("UPDATE conversation_media SET state = 'truncated', error_code = COALESCE(error_code, 'quota_or_backpressure') WHERE id = ?", [id]);
              await rm(temporary, { force: true });
              this.releaseReservation(acceptedBytes + (headerReserved ? 44 : 0));
              return;
            }
            const handle = await open(temporary, "r+");
            try {
              await handle.write(wavHeader(rate, sampleCount), 0, 44, 0);
              await handle.sync();
            } finally { await handle.close(); }
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await rename(temporary, target);
            await chmod(target, 0o600);
            const bytes = acceptedBytes + 44;
            const sha256 = await sha256File(target);
            this.db.run(`UPDATE conversation_media SET state = 'ready', delivery = ?, sample_count = ?,
              duration_ms = ?, bytes = ?, storage_key = ?, sha256 = ?, error_code = NULL WHERE id = ? AND state = 'pending'`,
            [delivery, sampleCount, Math.round(sampleCount * 1_000 / rate), bytes, storageKey, sha256, id]);
            if (this.db.query<{ state: string }, [string]>("SELECT state FROM conversation_media WHERE id = ?").get(id)?.state === "ready") {
              this.readyBytes += bytes;
            } else {
              await rm(target, { force: true });
            }
            this.releaseReservation(acceptedBytes + (headerReserved ? 44 : 0));
          } catch (error) {
            await rm(temporary, { force: true }).catch(() => {});
            await rm(target, { force: true }).catch(() => {});
            this.db.run("UPDATE conversation_media SET state = 'missing', error_code = 'io_failed', storage_key = NULL WHERE id = ?", [id]);
            this.releaseReservation(acceptedBytes + (headerReserved ? 44 : 0));
            throw error;
          }
        });
      },
    };
  }

  list(owner: string, sessionId: string): ConversationMediaDescriptor[] {
    return this.db.query<MediaRow, [string, string]>(
      "SELECT * FROM conversation_media WHERE owner_user_id = ? AND session_id = ? ORDER BY created_at, id",
    ).all(owner, sessionId).map(row => this.descriptor(row));
  }

  file(owner: string, sessionId: string, assetId: string): { path: string; descriptor: ConversationMediaDescriptor } | undefined {
    const row = this.db.query<MediaRow, [string, string, string]>(
      "SELECT * FROM conversation_media WHERE owner_user_id = ? AND session_id = ? AND id = ?",
    ).get(owner, sessionId, assetId);
    if (!row || row.state !== "ready" || row.storage_key === null) return undefined;
    const path = join(this.mediaDir, row.storage_key);
    if (!existsSync(path)) {
      this.db.run("UPDATE conversation_media SET state = 'missing', error_code = 'file_missing', storage_key = NULL WHERE id = ?", [assetId]);
      this.readyBytes = Math.max(0, this.readyBytes - row.bytes);
      return undefined;
    }
    return { path, descriptor: this.descriptor(row) };
  }

  removeSession(owner: string, sessionId: string): Promise<void> {
    return this.enqueue(`delete session ${sessionId}`, () => this.removeSessionNow(owner, sessionId));
  }

  private async drain(): Promise<void> {
    // An observer operation may discover an error and append its terminal metadata update
    // behind the tail that was current when draining began. Keep taking snapshots until
    // no operation extended the queue while the previous snapshot was running.
    for (;;) {
      const pending = this.tail;
      await pending;
      if (pending === this.tail) return;
    }
  }

  async flush(): Promise<void> { await this.drain(); }

  async close(): Promise<void> {
    if (this.closing) { await this.drain(); return; }
    this.closing = true;
    await this.drain();
    this.db.close();
  }
}
