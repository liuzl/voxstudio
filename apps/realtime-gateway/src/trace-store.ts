import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GatewayEvent } from "./protocol";

const SCHEMA_VERSION = 1;
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
}

export interface TracePolicy {
  enabled: true;
  content: boolean;
  audio: false;
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
  private closed = false;

  constructor(readonly dir: string, options: ConversationTraceStoreOptions = {}) {
    const retentionDays = positiveInteger(options.retentionDays, "trace retention days") ?? null;
    const maxConversations = positiveInteger(options.maxConversations, "trace max conversations") ?? null;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.policy = {
      enabled: true,
      content: options.retainContent === true,
      audio: false,
      retentionDays,
      maxConversations,
    };
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "traces.db"), { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
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
      content_retained INTEGER NOT NULL DEFAULT 0
    )`);
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
    this.reconcile();
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

  private prune(now = this.now()): void {
    if (this.policy.retentionDays !== null) {
      const cutoff = now - this.policy.retentionDays * 86_400_000;
      this.db.run("DELETE FROM conversations WHERE outcome != 'active' AND COALESCE(ended_at, started_at) < ?", [cutoff]);
    }
    if (this.policy.maxConversations !== null) {
      this.db.run(`DELETE FROM conversations WHERE id IN (
        SELECT id FROM conversations WHERE outcome != 'active'
        ORDER BY COALESCE(ended_at, started_at) DESC, id DESC LIMIT -1 OFFSET ?
      )`, [this.policy.maxConversations]);
    }
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
      SELECT 1 FROM conversations WHERE id = ? AND owner_user_id = ?
    )`, [event.sessionId, event.sequence, event.timestampMs, event.type, payloadJson, event.sessionId, owner]);
    if (result.changes === 0) return;
    if (event.type === "turn.completed") {
      this.db.run("UPDATE conversations SET turn_count = turn_count + 1 WHERE id = ? AND owner_user_id = ?", [event.sessionId, owner]);
    }
    if (event.type === "error" && event.recoverable === false) {
      this.db.run("UPDATE conversations SET error_code = ? WHERE id = ? AND owner_user_id = ?", [event.code, event.sessionId, owner]);
    }
  }

  finish(owner: string, sessionId: string, endedAt = this.now()): void {
    this.requireOpen();
    this.db.run(`UPDATE conversations SET
      ended_at = ?, outcome = CASE WHEN error_code IS NULL THEN 'completed' ELSE 'error' END
      WHERE id = ? AND owner_user_id = ? AND outcome = 'active'`, [endedAt, sessionId, owner]);
    this.prune(endedAt);
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
    const where = ["owner_user_id = ?", "agent_id = ?"];
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
    const row = this.db.query<TraceRow, [string, string, string]>(
      "SELECT * FROM conversations WHERE owner_user_id = ? AND agent_id = ? AND id = ?",
    ).get(owner, agentId, sessionId);
    if (!row) return undefined;
    const events = this.db.query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM conversation_events WHERE session_id = ? ORDER BY sequence ASC",
    ).all(sessionId).map(entry => JSON.parse(entry.payload_json) as GatewayEvent);
    return { ...this.summary(row), events };
  }

  remove(owner: string, agentId: string, sessionId: string): boolean {
    this.requireOpen();
    return this.db.run(
      "DELETE FROM conversations WHERE owner_user_id = ? AND agent_id = ? AND id = ?",
      [owner, agentId, sessionId],
    ).changes > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
