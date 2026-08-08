# Embedded LiveKit Runtime

Status: implemented for `vox studio`; release packaging embeds the platform-matching
LiveKit Server helper. Local WebSocket Media v2 remains the default and starts no RTC
process.

## Modes

| Mode | Enablement | Runtime shape |
|---|---|---|
| local/light | default | `vox` only; WebSocket Media v2 |
| embedded LiveKit | `vox studio --livekit embedded` or `VOX_LIVEKIT_EMBEDDED=1` | `vox` supervises one LiveKit Server child |
| external LiveKit | `VOX_LIVEKIT_URL` + API key/secret | `vox` connects to an operator-managed server |

Embedded and external mode are mutually exclusive. `VOX_LIVEKIT_PUBLIC_URL` is valid
in both modes: embedded mode uses loopback for the server-side Agent adapter and
returns this `wss://` override to browsers.

## Helper discovery and extraction

Tagged release builds import a checksum-verified platform helper with Bun's file
loader. The compiled `vox` contains those bytes and materializes them into the user's
VoxStudio cache on first use, under a content-addressed filename with owner-only
execute permissions. Subsequent starts reuse the same verified bytes.

Source builds discover the helper in this order:

1. `VOX_LIVEKIT_SERVER_BIN`;
2. a `livekit-server[.exe]` sibling beside `vox`;
3. `livekit-server` on `PATH` (plus conventional Homebrew paths on macOS).

The release workflow pins the LiveKit version and verifies upstream archive checksums
before compilation. The upstream executable is generated/downloaded during the build
and is never committed to this repository.

## Configuration and security

`vox` generates a new API key and a 48-byte random API secret on every start. The
complete LiveKit config is passed through the child's `LIVEKIT_CONFIG` environment;
credentials never appear in process arguments or logs. Restarting `vox` deliberately
invalidates old room grants.

The embedded signal listener always binds loopback. Configure the media-facing ports
and address with:

| Variable | Default | Purpose |
|---|---:|---|
| `VOX_LIVEKIT_EMBEDDED_PORT` | `7880` | loopback API/WebSocket signal port |
| `VOX_LIVEKIT_EMBEDDED_RTC_UDP_PORT` | `7882` | UDP-mux WebRTC media port |
| `VOX_LIVEKIT_EMBEDDED_RTC_TCP_PORT` | unset | optional ICE/TCP fallback |
| `VOX_LIVEKIT_EMBEDDED_NODE_IP` | auto interfaces | address advertised in ICE candidates |
| `VOX_LIVEKIT_PUBLIC_URL` | local `ws://` URL | browser-facing `wss://` signal URL |
| `VOX_LIVEKIT_TOKEN_TTL_SECONDS` | `300` | participant grant TTL, bounded to 30–600 s |

The helper inherits neither `LIVEKIT_KEYS` nor an operator's pre-existing
`LIVEKIT_CONFIG`, `NODE_IP`, or `UDP_PORT`; generated configuration is the sole source
of truth. Its default log level is `warn`: LiveKit's participant-level `info` logs can
contain complete SDP and ICE candidates, including network addresses.

## Lifecycle

Startup is transactional:

1. resolve/materialize the helper;
2. spawn it and drain both output pipes;
3. wait for the loopback signal endpoint;
4. create the existing `DefaultLiveKitAgentMediaAdapter`;
5. start the Studio gateway.

If any later startup step fails, the helper is stopped. Normal SIGINT/SIGTERM closes
the gateway and its Agent rooms before stopping LiveKit. An unexpected helper exit is
fatal to the full-realtime deployment and shuts Studio down rather than advertising a
media capability that no longer works.

## Network boundary

An HTTP tunnel or reverse proxy can expose LiveKit's API/WebSocket signal endpoint,
but it does not expose WebRTC UDP. Remote deployments must still provide a reachable
RTC UDP address/port or an appropriate TURN service. Embedded packaging changes
process ownership, not the WebRTC network requirements.

Embedded LiveKit Server does not include LiveKit SIP, Ingress, Egress, Redis, or a TLS
terminator. Those remain explicit optional deployment components.
