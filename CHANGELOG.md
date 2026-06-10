# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.6] - 2026-06-11

### Fixed

- The rc.5 pre-emption fix never engaged: the Rebroadcast plugin's prebuffer
  session calls `getVideoStream()` without a `destination`, which the
  destination heuristic classified as interactive (`force=true`), so the
  startup pre-emption loop continued unchanged. `undefined` destinations are
  now treated as background requests.
- `StreamManager.requestStream()` ignored the `force` flag once past the
  fast-path check: after acquiring the mutex it always pre-empted the running
  stream. Non-forced (background) requests now never pre-empt — they fail
  fast with `StreamBusyError` while another camera holds the slot, both in
  the fast path and re-checked under the mutex. The `minStreamDurationMs`
  cooldown is gone.

### Added

- New plugin setting "Prebuffer-Kamera": selects the single camera that keeps
  a permanent prebuffer stream (fast live-view start, HKSV pre-roll). All
  other cameras report `source: "cloud"` in their media stream options so the
  Rebroadcast plugin no longer auto-prebuffers them — with HomeBase 3's
  one-stream limit, prebuffering every camera is physically impossible and
  caused the endless pre-emption cycle. Default: no prebuffer camera.

## [1.0.0-beta.3] - 2026-06-04

### Fixed

- Load `eufy-security-client` as a runtime (optional) dependency instead of
  webpack-bundling it. Bundling stripped the package's JSON data files
  (e.g. `i18n-iso-countries/codes.json`), which made every country code fail
  validation with `Invalid ISO 3166-1 Alpha-2 country code`. Scrypted now
  installs the dependency on the target host, keeping its data and native
  bindings intact. Plugin bundle drops from ~2.9 MB to ~57 KB.

## [1.0.0-beta.2] - 2026-06-04

### Fixed

- Country/language settings are now trimmed and case-normalized before being
  passed to `eufy-security-client`. A trailing newline/space in the country
  field caused `Invalid ISO 3166-1 Alpha-2 country code` on connect.

## [1.0.0-beta.1] - 2026-06-04

### Notes

- First beta. Code-complete and green on build/lint/unit tests, but not yet
  verified against real HomeBase 3 / E330 / C210 hardware. Published under the
  npm `beta` dist-tag; install with `scrypted-eufy-security@beta`.

## [1.0.0] - 2026-06-04

### Added

- Direct `eufy-security-client` integration (no WebSocket bridge, no Docker).
- HomeBase 3 (S380) support over P2P.
- Camera, VideoCamera, MotionSensor and Settings interfaces per camera.
- Intercom (two-way audio) for devices that support it.
- PanTiltZoom for PT cameras (e.g. Indoor Cam C210).
- SecuritySystem (guard mode) per station.
- `StreamManager` with HomeBase-3 single-stream enforcement, session reuse,
  auto-cleanup grace period, start timeout and bounded auto-restart.
- In-process direct client with `enableEmbeddedPKCS1Support`, plus an automatic
  legacy-crypto child-process fallback (`--openssl-legacy-provider`).
- Automatic reconnect with exponential backoff.
- 2FA and CAPTCHA handling via plugin settings.
- Unit tests for the client adapter, stream manager and plugin discovery.
- CI (Node 22.x / 24.x) and NPM release workflows.
