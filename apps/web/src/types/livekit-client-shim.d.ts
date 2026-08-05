/**
 * The public surface VoxStudio uses from livekit-client.
 *
 * livekit-client 2.21 publishes declarations that reference its unpublished
 * @livekit/throws-transformer build-time module and conflict with
 * exactOptionalPropertyTypes. Keep application checking strict without globally
 * suppressing declaration errors; Vite still resolves the runtime package normally.
 */

export interface AudioCaptureOptions {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
  deviceId?: string | { exact: string };
}

export interface LocalAudioTrack {
  mediaStreamTrack: MediaStreamTrack;
  mute(): Promise<unknown>;
  unmute(): Promise<unknown>;
  stop(): void;
  getRTCStatsReport(): Promise<RTCStatsReport | undefined>;
}

export declare const AudioPresets: {
  readonly speech: unknown;
};

export declare const RoomEvent: {
  readonly Reconnecting: string;
  readonly SignalReconnecting: string;
  readonly Reconnected: string;
  readonly Disconnected: string;
  readonly TrackSubscribed: string;
  readonly TrackUnsubscribed: string;
  readonly DataReceived: string;
};

export declare const Track: {
  readonly Source: { readonly Microphone: string };
  readonly Kind: { readonly Audio: string };
};

export declare class Room {
  constructor(options?: { adaptiveStream?: boolean });
}

export declare function createLocalAudioTrack(options?: AudioCaptureOptions): Promise<LocalAudioTrack>;
