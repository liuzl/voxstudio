import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FinalizedInputAudio } from "@voxstudio/conversation";
import type { GatewayEvent } from "./protocol";
import {
  ConversationMediaStore,
  type ConversationMediaDescriptor,
  type OutputMediaRecorder,
} from "./media-store";

const SCHEMA_VERSION = 2;
const MAX_EVENT_JSON_BYTES = 64 * 1024;

export type TraceOutcome = "active" | "completed" | "error" | "abandoned";
export type TraceAgentSource = "draft" | "published";

export interface TraceAgentIdentity {
  agentId: string;
  source: TraceAgentSource;
  revision?: number;
  version?: number;
  hash?: string;
}

export interface ConversationTraceSummary {
  id: string;
  agentId: string;
  agentSource: TraceAgentSource;
  agentRevision: number | null;
  agentVersion: number | null;
  agentHash: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  outcome: TraceOutcome;
  errorCode: string | null;
  turnCount: number;
  contentRetained: boolean;
}

export interface ConversationTraceDetail extends ConversationTraceSummary {
  events: GatewayEvent[];
  media: ConversationMediaDescriptor[];
}

export interface TracePolicy {
  enabled: true;
  content: boolean;
  audio: boolean;
  inputAudio: boolean;
  outputAudio: boolean;
  maxBytes: number | null;
  retentionDays: number | null;
  maxConversations: number | null;
}

export interface ConversationTraceStoreOptions {
  /** Transcript text, reply text, tool arguments/results, and generated-take text. */
  retainContent?: boolean;
  /** Completed records older than this are removed. Unbounded when absent. */
  retentionDays?: number;
  /** Oldest completed records beyond this deployment-wide count are removed. */
  maxConversations?: number;
  /** Retain canonical user utterance WAVs. Independent from content. */
  retainInputAudio?: boolean;
  /** Retain canonical Agent PCM successfully submitted to the active media sink. */
  retainOutputAudio?: boolean;
  /** Deployment-wide ceiling over retained conversation WAV bytes. */
  maxBytes?: number;
  /** Read historical retained audio even when new capture is disabled. False for demo deployments. */
  serveRetainedAudio?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

interface TraceRow {
  id: string;
  agent_id: string;
  agent_source: TraceAgentSource;
  agent_revision: number | null;
  agent_version: number | null;
  agent_hash: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: TraceOutcome;
  error_code: string | null;
  turn_count: number;
  content_retained: number;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/**
 * Remove conversational content while retaining operational truth. Event names,
 * timestamps, state, timing, tool names/outcomes, and error codes remain useful without
 * persisting what anybody said or passed to a tool.
 */
export function traceEventForRetention(event: GatewayEvent, retainContent: boolean): GatewayEvent {
  if (retainContent) return event;
  const redacted = { ...event } as GatewayEvent & Record<string, unknown>;
  if (event.type === "transcript.final" || event.type === "response.text.delta" || event.type === "response.text.final") {
    delete redacted.text;
  } else if (event.type === "tool.call" || event.type === "tool.pending") {
    delete redacted.arguments;
  } else if (event.type === "tool.result") {
    delete redacted.result;
  } else if (event.type === "studio.take") {
    delete redacted.text;
  } else if (event.type === "session.notice" || event.type === "error") {
    delete redacted.message;
  }
  return redacted;
}

/**
 * SQLite-backed Agent conversation metadata and protocol trace store. Construction is
 * the retention opt-in: a gateway without this object writes nothing. Audio never enters
 * this store. Content is an independent policy bit and defaults off.
 */
export class ConversationTraceStore {
  readonly policy: TracePolicy;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly pruneTimer: ReturnType<typeof setInterval> | undefined;
  private readonly media: ConversationMediaStore | undefined;
  private readonly deletionJobs = new Map<string, Promise<void>>();
  private closed = false;

  constructor(readonly dir: string, options: ConversationTraceStoreOptions = {}) {
    const retentionDays = positiveInteger(options.retentionDays, "trace retention days") ?? null;
    const maxConversations = positiveInteger(options.maxConversations, "trace max conversations") ?? null;
    const maxBytes = positiveInteger(options.maxBytes, "trace max bytes") ?? null;
    const inputAudio = options.retainInputAudio === true;
    const outputAudio = options.retainOutputAudio === true;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.policy = {
      enabled: true,
      content: options.retainContent === true,
      audio: inputAudio || outputAudio,
      inputAudio,
      outputAudio,
      maxBytes,
      retentionDays,
      maxConversations,
    };
    // Trace content can contain transcripts and tool payloads. Do not inherit a
    // process-wide 022 umask here: on a multi-user host that makes the store readable by
    // every local account. chmod also repairs directories created by an older release.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const databasePath = join(dir, "traces.db");
    this.db = new Database(databasePath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_source TEXT NOT NULL CHECK (agent_source IN ('draft', 'published')),
      agent_revision INTEGER,
      agent_version INTEGER,
      agent_hash TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      outcome TEXT NOT NULL CHECK (outcome IN ('active', 'completed', 'error', 'abandoned')),
      error_code TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      content_retained INTEGER NOT NULL DEFAULT 0,
      deleting INTEGER NOT NULL DEFAULT 0
    )`);
    const conversationColumns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().map(row => row.name));
    if (!conversationColumns.has("deleting")) {
      this.db.run("ALTER TABLE conversations ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0");
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS conversation_events (
      session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS conversations_owner_agent_started ON conversations (owner_user_id, agent_id, started_at DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS conversation_events_session_time ON conversation_events (session_id, timestamp_ms, sequence)");
    this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const openMedia = inputAudio || outputAudio
      || (options.serveRetainedAudio !== false && existsSync(join(dir, "media.db")));
    this.media = openMedia
      ? new ConversationMediaStore(dir, {
          ...(maxBytes === null ? {} : { maxBytes }),
          now: this.now,
          log: this.log,
          evictionCandidates: (protectedOwner, protectedSessionId) => this.db.query<{
            owner_user_id: string; id: string;
          }, [string, string]>(`SELECT owner_user_id, id FROM conversations
            WHERE outcome != 'active' AND deleting = 0
              AND NOT (owner_user_id = ? AND id = ?)
            ORDER BY COALESCE(ended_at, started_at) ASC, id ASC`).all(protectedOwner, protectedSessionId)
            .map(row => ({ owner: row.owner_user_id, sessionId: row.id })),
          beginEviction: (owner, sessionId) => this.markDeleting(owner, sessionId),
          finishEviction: (owner, sessionId) => { this.finishDeleting(owner, sessionId); },
        })
      : undefined;
    this.reconcile();
    this.media?.removeUnknownSessions(new Set(this.db.query<{ owner_user_id: string; id: string }, []>(
      "SELECT owner_user_id, id FROM conversations",
    ).all().map(row => `${row.owner_user_id}\0${row.id}`)));
    this.retryDeleting();
    this.pruneTimer = this.policy.retentionDays === null
      ? undefined
      : setInterval(() => {
          if (this.closed) return;
          try { this.prune(); }
          catch (error) { this.log(`traces: scheduled prune failed: ${error instanceof Error ? error.message : String(error)}`); }
        }, Math.min(3_600_000, Math.max(60_000, this.policy.retentionDays * 3_600_000)));
  }

  get isClosed(): boolean { return this.closed; }

  private requireOpen(): void {
    if (this.closed) throw new Error("the conversation trace store is closed");
  }

  /** A process crash cannot leave an old row pretending to be live forever. */
  private reconcile(): void {
    const now = this.now();
    const abandoned = this.db.run(
      "UPDATE conversations SET outcome = 'abandoned', ended_at = ? WHERE outcome = 'active'",
      [now],
    ).changes;
    if (abandoned > 0) this.log(`traces: marked ${abandoned} interrupted session(s) abandoned`);
    this.prune(now);
  }

  private deletionKey(owner: string, sessionId: string): string { return `${owner}\0${sessionId}`; }

  private markDeleting(owner: string, sessionId: string): boolean {
    return this.db.run(
      "UPDATE conversations SET deleting = 1 WHERE owner_user_id = ? AND id = ? AND outcome != 'active' AND deleting = 0",
      [owner, sessionId],
    ).changes > 0;
  }

  private finishDeleting(owner: string, sessionId: string): void {
    this.db.run("DELETE FROM conversations WHERE owner_user_id = ? AND id = ? AND deleting = 1", [owner, sessionId]);
  }

  private scheduleDeletion(owner: string, sessionId: string): Promise<void> {
    const key = this.deletionKey(owner, sessionId);
    const existing = this.deletionJobs.get(key);
    if (existing !== undefined) return existing;
    const job = (async () => {
      await this.media?.removeSession(owner, sessionId);
      this.finishDeleting(owner, sessionId);
    })();
    this.deletionJobs.set(key, job);
    void job.then(
      () => { this.deletionJobs.delete(key); },
      error => {
        this.deletionJobs.delete(key);
        this.log(`traces: deletion ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return job;
  }

  private retryDeleting(): void {
    for (const row of this.db.query<{ owner_user_id: string; id: string }, []>(
      "SELECT owner_user_id, id FROM conversations WHERE deleting = 1",
    ).all()) {
      void this.scheduleDeletion(row.owner_user_id, row.id);
    }
  }

  private prune(now = this.now()): void {
    this.retryDeleting();
    if (this.policy.retentionDays !== null) {
      const cutoff = now - this.policy.retentionDays * 86_400_000;
      const expired = this.db.query<{ owner_user_id: string; id: string }, [number]>(
        "SELECT owner_user_id, id FROM conversations WHERE outcome != 'active' AND deleting = 0 AND COALESCE(ended_at, started_at) < ?",
      ).all(cutoff);
      for (const row of expired) {
        if (this.markDeleting(row.owner_user_id, row.id)) void this.scheduleDeletion(row.owner_user_id, row.id);
      }
    }
    if (this.policy.maxConversations !== null) {
      const excess = this.db.query<{ owner_user_id: string; id: string }, [number]>(`SELECT owner_user_id, id FROM conversations WHERE id IN (
        SELECT id FROM conversations WHERE outcome != 'active' AND deleting = 0
        ORDER BY COALESCE(ended_at, started_at) DESC, id DESC LIMIT -1 OFFSET ?
      )`).all(this.policy.maxConversations);
      for (const row of excess) {
        if (this.markDeleting(row.owner_user_id, row.id)) void this.scheduleDeletion(row.owner_user_id, row.id);
      }
    }
    if (this.policy.maxBytes !== null && this.media !== undefined) {
      let projectedBytes = this.media.bytesUsed();
      const oldest = this.db.query<{ owner_user_id: string; id: string }, []>(
        `SELECT owner_user_id, id FROM conversations WHERE outcome != 'active' AND deleting = 0
         ORDER BY COALESCE(ended_at, started_at) ASC, id ASC`,
      ).all();
      for (const row of oldest) {
        if (projectedBytes <= this.policy.maxBytes) break;
        const bytes = this.media.sessionBytes(row.owner_user_id, row.id);
        if (bytes === 0) continue;
        if (this.markDeleting(row.owner_user_id, row.id)) {
          projectedBytes = Math.max(0, projectedBytes - bytes);
          void this.scheduleDeletion(row.owner_user_id, row.id);
        }
      }
    }
  }

  retainInput(owner: string, utterance: FinalizedInputAudio): void {
    if (!this.policy.inputAudio) return;
    this.media?.retainInput(owner, utterance);
  }

  createOutputRecorder(owner: string, sessionId: string, turnId: string, revision: number): OutputMediaRecorder | undefined {
    if (!this.policy.outputAudio) return undefined;
    return this.media?.createOutputRecorder(owner, sessionId, turnId, revision);
  }

  begin(owner: string, sessionId: string, agent: TraceAgentIdentity, startedAt = this.now()): void {
    this.requireOpen();
    this.db.run(`INSERT INTO conversations (
      id, owner_user_id, agent_id, agent_source, agent_revision, agent_version,
      agent_hash, started_at, outcome, content_retained
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`, [
      sessionId,
      owner,
      agent.agentId,
      agent.source,
      agent.revision ?? null,
      agent.version ?? null,
      agent.hash ?? null,
      startedAt,
      this.policy.content ? 1 : 0,
    ]);
  }

  append(owner: string, event: GatewayEvent): void {
    this.requireOpen();
    // Streaming deltas can turn one reply into hundreds of rows while the final event
    // already carries the exact retained text. Timing/state events preserve latency
    // truth, so dropping deltas loses neither the transcript nor operational evidence.
    if (event.type === "response.text.delta") return;
    const retained = traceEventForRetention(event, this.policy.content);
    let payloadJson = JSON.stringify(retained);
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_EVENT_JSON_BYTES) {
      const record = retained as GatewayEvent & Record<string, unknown>;
      payloadJson = JSON.stringify({
        v: retained.v,
        sessionId: retained.sessionId,
        sequence: retained.sequence,
        timestampMs: retained.timestampMs,
        type: retained.type,
        ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        truncated: true,
      });
    }
    const result = this.db.run(`INSERT OR IGNORE INTO conversation_events (
      session_id, sequence, timestamp_ms, type, payload_json
      ) SELECT ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM conversations WHERE id = ? AND owner_user_id = ? AND deleting = 0
    )`, [event.sessionId, event.sequence, event.timestampMs, event.type, payloadJson, event.sessionId, owner]);
    if (result.changes === 0) return;
    if (event.type === "turn.completed") {
      this.db.run("UPDATE conversations SET turn_count = turn_count + 1 WHERE id = ? AND owner_user_id = ?", [event.sessionId, owner]);
    }
    if (event.type === "error" && event.recoverable === false) {
      this.db.run("UPDATE conversations SET error_code = ? WHERE id = ? AND owner_user_id = ?", [event.code, event.sessionId, owner]);
    }
  }

  /** Coalesce a gateway tick's observer writes into one SQLite transaction. */
  batch(operation: () => void): void {
    this.requireOpen();
    this.db.transaction(operation)();
  }

  finish(owner: string, sessionId: string, endedAt = this.now()): void {
    this.requireOpen();
    this.db.run(`UPDATE conversations SET
      ended_at = ?, outcome = CASE WHEN error_code IS NULL THEN 'completed' ELSE 'error' END
      WHERE id = ? AND owner_user_id = ? AND outcome = 'active' AND deleting = 0`, [endedAt, sessionId, owner]);
    this.prune(endedAt);
  }

  markError(owner: string, sessionId: string, code: string): void {
    this.requireOpen();
    this.db.run(
      "UPDATE conversations SET error_code = COALESCE(error_code, ?) WHERE id = ? AND owner_user_id = ? AND deleting = 0",
      [code, sessionId, owner],
    );
  }

  private summary(row: TraceRow): ConversationTraceSummary {
    const endedAt = row.ended_at;
    return {
      id: row.id,
      agentId: row.agent_id,
      agentSource: row.agent_source,
      agentRevision: row.agent_revision,
      agentVersion: row.agent_version,
      agentHash: row.agent_hash,
      startedAt: row.started_at,
      endedAt,
      durationMs: Math.max(0, (endedAt ?? this.now()) - row.started_at),
      outcome: row.outcome,
      errorCode: row.error_code,
      turnCount: row.turn_count,
      contentRetained: row.content_retained === 1,
    };
  }

  list(owner: string, agentId: string, options: {
    limit?: number;
    offset?: number;
    outcome?: TraceOutcome;
    from?: number;
    to?: number;
    minDurationMs?: number;
    maxDurationMs?: number;
    id?: string;
  } = {}): { conversations: ConversationTraceSummary[]; total: number; policy: TracePolicy } {
    this.requireOpen();
    // Reads are a second enforcement point beside the timer. Even if the event loop was
    // suspended through the deadline, expired content is removed before it can be served.
    this.prune();
    const where = ["owner_user_id = ?", "agent_id = ?", "deleting = 0"];
    const values: Array<string | number> = [owner, agentId];
    if (options.outcome !== undefined) { where.push("outcome = ?"); values.push(options.outcome); }
    if (options.from !== undefined) { where.push("started_at >= ?"); values.push(options.from); }
    if (options.to !== undefined) { where.push("started_at <= ?"); values.push(options.to); }
    if (options.minDurationMs !== undefined) { where.push("COALESCE(ended_at, ?) - started_at >= ?"); values.push(this.now(), options.minDurationMs); }
    if (options.maxDurationMs !== undefined) { where.push("COALESCE(ended_at, ?) - started_at <= ?"); values.push(this.now(), options.maxDurationMs); }
    if (options.id !== undefined) { where.push("id = ?"); values.push(options.id); }
    const clause = where.join(" AND ");
    const total = this.db.query<{ total: number }, Array<string | number>>(`SELECT COUNT(*) AS total FROM conversations WHERE ${clause}`).get(...values)?.total ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.db.query<TraceRow, Array<string | number>>(
      `SELECT * FROM conversations WHERE ${clause} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...values, limit, offset);
    return { conversations: rows.map(row => this.summary(row)), total, policy: this.policy };
  }

  get(owner: string, agentId: string, sessionId: string): ConversationTraceDetail | undefined {
    this.requireOpen();
    this.prune();
    const row = this.db.query<TraceRow, [string, string, string]>(
      "SELECT * FROM conversations WHERE owner_user_id = ? AND agent_id = ? AND id = ? AND deleting = 0",
    ).get(owner, agentId, sessionId);
    if (!row) return undefined;
    const events = this.db.query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM conversation_events WHERE session_id = ? ORDER BY sequence ASC",
    ).all(sessionId).map(entry => JSON.parse(entry.payload_json) as GatewayEvent);
    return { ...this.summary(row), events, media: this.media?.list(owner, sessionId) ?? [] };
  }

  mediaFile(owner: string, agentId: string, sessionId: string, assetId: string):
    { path: string; descriptor: ConversationMediaDescriptor } | undefined {
    this.requireOpen();
    const ownsConversation = this.db.query<{ found: number }, [string, string, string]>(
      "SELECT 1 AS found FROM conversations WHERE owner_user_id = ? AND agent_id = ? AND id = ? AND deleting = 0",
    ).get(owner, agentId, sessionId);
    return ownsConversation ? this.media?.file(owner, sessionId, assetId) : undefined;
  }

  /** Drain observer file work for shutdown and deterministic retention tests. */
  async flushMedia(): Promise<void> {
    await this.media?.flush();
    await Promise.allSettled([...this.deletionJobs.values()]);
  }

  async remove(owner: string, agentId: string, sessionId: string): Promise<"deleted" | "active" | "not_found"> {
    this.requireOpen();
    const row = this.db.query<{ outcome: TraceOutcome; deleting: number }, [string, string, string]>(
      "SELECT outcome, deleting FROM conversations WHERE owner_user_id = ? AND agent_id = ? AND id = ?",
    ).get(owner, agentId, sessionId);
    if (row == null) return "not_found";
    // A live session still owns retention callbacks. Refusing the transition is the only
    // safe behavior until a caller explicitly stops it; otherwise audio can reappear after
    // a successful DELETE response.
    if (row.outcome === "active") return "active";
    if (row.deleting === 0 && !this.markDeleting(owner, sessionId)) return "not_found";
    await this.scheduleDeletion(owner, sessionId);
    return "deleted";
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    await Promise.allSettled([...this.deletionJobs.values()]);
    await this.media?.close();
    this.db.close();
  }
}
