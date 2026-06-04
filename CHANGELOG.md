# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
