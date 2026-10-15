# Browser viewport calibration

Run `vp run --filter @t3tools/desktop test:preview-calibration` from the repository root. `.scratch/` must be ignored. The check launches an isolated, hidden Electron window with a synthetic calibration page and saves PNGs plus scalar measurements under `.scratch/preview-calibration/`.

The active `fork-ci.yml` runs this check on Linux and macOS and requires both matrix entries to pass through `Fork Check`. Each run uploads the calibration images and measurements as workflow artifacts.

## Coverage

This is a native desktop integration test. It calls the production `resolveBrowserViewportLayout` function, applies its dimensions to a minimal webview host, and uses the real `PreviewManager` for CDP viewport emulation, page/window zoom, snapshot capture, and locator clicks. A compositor-frame event establishes that the resized surface has been presented before pixels are checked.

The thirteen scenarios cover nine window/page zoom combinations, a phone-sized viewport, a smaller available preview area, resizing that area back, and clearing the fitted override at natural size. Each snapshot checks 36 reference pixels, requested CSS dimensions, screenshot geometry, page console errors, and a click at the button's center. The small/resized-back cases change dimensions of the same webview; they do not exercise mini-player or panel hide/reopen transitions.

The test does not launch the complete styal app. It bypasses React components, toolbar state and controls, surface ownership/reparenting, IPC, the server and MCP transport, provider adapters, and remote/relay connections. It does not exercise native mobile clients, recordings, or DevTools fallback. Passing establishes that this native rendering/capture/input path works for the tested sizes and zooms; a complete Browser panel flow needs a separate app-level test.
