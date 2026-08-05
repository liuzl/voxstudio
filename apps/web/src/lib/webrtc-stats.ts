export type WebRtcStatsDirection = "uplink" | "downlink";

export interface WebRtcStatsSample {
  atMs: number;
  direction: WebRtcStatsDirection;
  /** Browser RTCStats id for the selected RTP stream; required to audit track replacement. */
  streamId?: string;
  bytes: number;
  /** RTP payload bytes received/sent since this stream epoch began. */
  bytesDelta: number;
  /** Cumulative RTP header bytes when exposed by the browser. */
  headerBytes?: number;
  /** RTP header bytes since this stream epoch began. */
  headerBytesDelta?: number;
  /** Payload plus RTP header bytes for billing reconciliation. */
  rtpBytesDelta?: number;
  packets: number;
  packetsLost?: number;
  bitrateKbps?: number;
  /** Payload plus RTP header bitrate; unlike bitrateKbps this includes exposed RTP overhead. */
  rtpBitrateKbps?: number;
  packetLossPct?: number;
  jitterMs?: number;
  roundTripTimeMs?: number;
  jitterBufferMs?: number;
  jitterBufferTargetMs?: number;
  jitterBufferMinimumMs?: number;
  concealedSamplesDelta?: number;
  concealmentEventsDelta?: number;
  codec?: string;
  sampleRate?: number;
}

export interface RtcStatsReportLike {
  forEach(callback: (value: unknown) => void): void;
}

interface Counters {
  streamId?: string;
  timestamp: number;
  bytes: number;
  headerBytes?: number;
  packets: number;
  packetsLost?: number;
  jitterBufferDelay?: number;
  jitterBufferTargetDelay?: number;
  jitterBufferMinimumDelay?: number;
  jitterBufferEmittedCount?: number;
  concealedSamples?: number;
  concealmentEvents?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function audio(record: Record<string, unknown>): boolean {
  return record.kind === "audio" || record.mediaType === "audio";
}

function preferred(records: Record<string, unknown>[], direction: WebRtcStatsDirection): Record<string, unknown> | undefined {
  const type = direction === "uplink" ? "outbound-rtp" : "inbound-rtp";
  return records
    .filter(candidate => candidate.type === type && candidate.isRemote !== true && candidate.active !== false && audio(candidate))
    .sort((left, right) => (finite(right.bytesSent ?? right.bytesReceived) ?? 0) - (finite(left.bytesSent ?? left.bytesReceived) ?? 0))[0];
}

function selectedPair(records: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const byId = new Map(records.flatMap(candidate => text(candidate.id) === undefined ? [] : [[candidate.id as string, candidate] as const]));
  const transport = records.find(candidate => candidate.type === "transport" && text(candidate.selectedCandidatePairId) !== undefined);
  const selected = transport === undefined ? undefined : byId.get(transport.selectedCandidatePairId as string);
  return selected ?? records.find(candidate => candidate.type === "candidate-pair"
    && candidate.state === "succeeded" && (candidate.selected === true || candidate.nominated === true));
}

/**
 * Converts browser RTCStatsReport counters into bounded, unit-stable samples. Deltas are
 * derived here so traces never need browser-specific report shapes or cumulative math.
 */
export class WebRtcStatsSampler {
  private readonly previous = new Map<WebRtcStatsDirection, Counters>();

  sample(report: RtcStatsReportLike, direction: WebRtcStatsDirection, atMs: number): WebRtcStatsSample | undefined {
    const records: Record<string, unknown>[] = [];
    report.forEach(value => {
      const candidate = record(value);
      if (candidate !== undefined) records.push(candidate);
    });
    const primary = preferred(records, direction);
    if (primary === undefined) return undefined;
    const byId = new Map(records.flatMap(candidate => text(candidate.id) === undefined ? [] : [[candidate.id as string, candidate] as const]));
    const remote = direction === "uplink"
      ? (text(primary.remoteId) === undefined ? undefined : byId.get(primary.remoteId as string))
        ?? records.find(candidate => candidate.type === "remote-inbound-rtp" && candidate.localId === primary.id)
      : undefined;
    const codec = text(primary.codecId) === undefined ? undefined : byId.get(primary.codecId as string);
    const pair = selectedPair(records);
    const ssrc = finite(primary.ssrc);
    const streamId = text(primary.id) ?? (ssrc === undefined ? undefined : `ssrc:${ssrc}`);
    const bytes = Math.max(0, finite(direction === "uplink" ? primary.bytesSent : primary.bytesReceived) ?? 0);
    const headerBytes = finite(direction === "uplink" ? primary.headerBytesSent : primary.headerBytesReceived);
    const packets = Math.max(0, finite(direction === "uplink" ? primary.packetsSent : primary.packetsReceived) ?? 0);
    const packetsLost = finite(remote?.packetsLost ?? primary.packetsLost);
    const jitterBufferDelay = finite(primary.jitterBufferDelay);
    const jitterBufferTargetDelay = finite(primary.jitterBufferTargetDelay);
    const jitterBufferMinimumDelay = finite(primary.jitterBufferMinimumDelay);
    const jitterBufferEmittedCount = finite(primary.jitterBufferEmittedCount);
    const concealedSamples = finite(primary.concealedSamples);
    const concealmentEvents = finite(primary.concealmentEvents);
    const counters: Counters = {
      ...(streamId === undefined ? {} : { streamId }),
      timestamp: finite(primary.timestamp) ?? atMs,
      bytes,
      ...(headerBytes === undefined ? {} : { headerBytes: Math.max(0, headerBytes) }),
      packets,
      ...(packetsLost === undefined ? {} : { packetsLost }),
      ...(jitterBufferDelay === undefined ? {} : { jitterBufferDelay }),
      ...(jitterBufferTargetDelay === undefined ? {} : { jitterBufferTargetDelay }),
      ...(jitterBufferMinimumDelay === undefined ? {} : { jitterBufferMinimumDelay }),
      ...(jitterBufferEmittedCount === undefined ? {} : { jitterBufferEmittedCount }),
      ...(concealedSamples === undefined ? {} : { concealedSamples }),
      ...(concealmentEvents === undefined ? {} : { concealmentEvents }),
    };
    const candidatePrevious = this.previous.get(direction);
    const previous = candidatePrevious !== undefined
      && (candidatePrevious.streamId === undefined || streamId === undefined || candidatePrevious.streamId === streamId)
      ? candidatePrevious
      : undefined;
    this.previous.set(direction, counters);
    const elapsedMs = previous === undefined ? 0 : counters.timestamp - previous.timestamp;
    const rawBytesDelta = previous === undefined ? counters.bytes : counters.bytes - previous.bytes;
    // A counter reset begins a new epoch. Its current value represents traffic already
    // received in that epoch and must not disappear from billing reconciliation.
    const bytesDelta = rawBytesDelta < 0 ? counters.bytes : rawBytesDelta;
    const rawHeaderBytesDelta = counters.headerBytes === undefined
      ? undefined
      : previous?.headerBytes === undefined
        ? counters.headerBytes
        : counters.headerBytes - previous.headerBytes;
    const headerBytesDelta = rawHeaderBytesDelta === undefined
      ? undefined
      : rawHeaderBytesDelta < 0 ? counters.headerBytes : rawHeaderBytesDelta;
    const packetsDelta = previous === undefined ? -1 : counters.packets - previous.packets;
    const lostDelta = previous?.packetsLost === undefined || counters.packetsLost === undefined
      ? undefined
      : counters.packetsLost - previous.packetsLost;
    const lossDenominator = packetsDelta >= 0 && lostDelta !== undefined && lostDelta >= 0
      ? packetsDelta + (direction === "downlink" ? lostDelta : 0)
      : 0;
    const jitterSeconds = finite(remote?.jitter ?? primary.jitter);
    const rttSeconds = finite(remote?.roundTripTime ?? pair?.currentRoundTripTime ?? primary.roundTripTime);
    const bufferDelayDelta = previous?.jitterBufferDelay === undefined || counters.jitterBufferDelay === undefined
      ? undefined : counters.jitterBufferDelay - previous.jitterBufferDelay;
    const bufferCountDelta = previous?.jitterBufferEmittedCount === undefined || counters.jitterBufferEmittedCount === undefined
      ? undefined : counters.jitterBufferEmittedCount - previous.jitterBufferEmittedCount;
    const bufferTargetDelta = previous?.jitterBufferTargetDelay === undefined || counters.jitterBufferTargetDelay === undefined
      ? undefined : counters.jitterBufferTargetDelay - previous.jitterBufferTargetDelay;
    const bufferMinimumDelta = previous?.jitterBufferMinimumDelay === undefined || counters.jitterBufferMinimumDelay === undefined
      ? undefined : counters.jitterBufferMinimumDelay - previous.jitterBufferMinimumDelay;
    const concealedDelta = previous?.concealedSamples === undefined || counters.concealedSamples === undefined
      ? undefined : counters.concealedSamples - previous.concealedSamples;
    const concealmentEventsDelta = previous?.concealmentEvents === undefined || counters.concealmentEvents === undefined
      ? undefined : counters.concealmentEvents - previous.concealmentEvents;
    return {
      atMs,
      direction,
      ...(streamId === undefined ? {} : { streamId }),
      bytes,
      bytesDelta,
      ...(counters.headerBytes === undefined ? {} : { headerBytes: counters.headerBytes }),
      ...(headerBytesDelta === undefined ? {} : { headerBytesDelta }),
      ...(headerBytesDelta === undefined ? {} : { rtpBytesDelta: bytesDelta + headerBytesDelta }),
      packets,
      ...(packetsLost === undefined ? {} : { packetsLost }),
      ...(elapsedMs <= 0 || rawBytesDelta < 0 ? {} : { bitrateKbps: rawBytesDelta * 8 / elapsedMs }),
      ...(elapsedMs <= 0 || rawBytesDelta < 0 || previous?.headerBytes === undefined
        || rawHeaderBytesDelta === undefined || rawHeaderBytesDelta < 0
        ? {} : { rtpBitrateKbps: (rawBytesDelta + rawHeaderBytesDelta) * 8 / elapsedMs }),
      ...(lossDenominator <= 0 || lostDelta === undefined ? {} : { packetLossPct: Math.min(100, lostDelta * 100 / lossDenominator) }),
      ...(jitterSeconds === undefined ? {} : { jitterMs: Math.max(0, jitterSeconds * 1_000) }),
      ...(rttSeconds === undefined ? {} : { roundTripTimeMs: Math.max(0, rttSeconds * 1_000) }),
      ...(bufferDelayDelta === undefined || bufferCountDelta === undefined || bufferDelayDelta < 0 || bufferCountDelta <= 0
        ? {} : { jitterBufferMs: bufferDelayDelta * 1_000 / bufferCountDelta }),
      ...(bufferTargetDelta === undefined || bufferCountDelta === undefined || bufferTargetDelta < 0 || bufferCountDelta <= 0
        ? {} : { jitterBufferTargetMs: bufferTargetDelta * 1_000 / bufferCountDelta }),
      ...(bufferMinimumDelta === undefined || bufferCountDelta === undefined || bufferMinimumDelta < 0 || bufferCountDelta <= 0
        ? {} : { jitterBufferMinimumMs: bufferMinimumDelta * 1_000 / bufferCountDelta }),
      ...(concealedDelta === undefined || concealedDelta < 0 ? {} : { concealedSamplesDelta: concealedDelta }),
      ...(concealmentEventsDelta === undefined || concealmentEventsDelta < 0 ? {} : { concealmentEventsDelta }),
      ...(text(codec?.mimeType) === undefined ? {} : { codec: text(codec?.mimeType) as string }),
      ...(finite(codec?.clockRate) === undefined ? {} : { sampleRate: finite(codec?.clockRate) as number }),
    };
  }

  reset(): void {
    this.previous.clear();
  }
}
