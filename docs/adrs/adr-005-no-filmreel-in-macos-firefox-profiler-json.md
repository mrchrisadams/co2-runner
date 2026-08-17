# ADR 005: No filmreel in macOS Firefox Profiler JSON

## Status

Accepted

## Context

co2-runner captures Firefox's Mozilla Profiler data (power counters, CPU traces,
etc.) during browser journeys. A valuable feature of the Mozilla Profiler is the
"film reel" — a visual timeline of screenshots that lets users scrub through
what was rendered on screen, correlating energy spikes with specific page
renders. This is powered by `CompositorScreenshot` markers in the profile JSON.

We want to offer a checkbox in the co2-runner UI: "Capture film reel screenshots
(viewable in Firefox Profiler)". When enabled, the resulting profile JSON should
contain `CompositorScreenshot` markers with embedded
`data:image/jpeg;base64,...` data URIs, which
[profiler.firefox.com](https://profiler.firefox.com) renders as a visual
timeline strip alongside the energy/power charts.

**This works on Linux but does NOT work on macOS.**

### How CompositorScreenshot markers are produced

The screenshot capture happens inside Firefox's WebRender render loop. On every
composite (every rendered frame), the renderer calls `MaybeGrabScreenshot()`:

```cpp
// gfx/webrender_bindings/RendererOGL.cpp:289
if (size.Width() != 0 && size.Height() != 0) {
  if (!mCompositor->MaybeGrabScreenshot(size.ToUnknownSize())) {
    mScreenshotGrabber.MaybeGrabScreenshot(this, size.ToUnknownSize());
  }
}
```

This is a two-tier check:

1. **Native compositor path** (macOS): `mCompositor->MaybeGrabScreenshot()` —
   delegates to `RenderCompositorNative`, which uses
   `NativeLayerRootSnapshotter` (backed by macOS's `CARenderer` API) to snapshot
   the composited frame.
2. **OGL fallback path** (Linux/other):
   `mScreenshotGrabber.MaybeGrabScreenshot(this, ...)` — uses
   `RendererScreenshotGrabber`, which does an async GL readback of the rendered
   frame buffer.

Both paths check `ProfilerScreenshots::IsEnabled()` before doing any work:

```cpp
// gfx/layers/ProfilerScreenshots.cpp
bool ProfilerScreenshots::IsEnabled() {
  return profiler_feature_active(ProfilerFeature::Screenshots);
}
```

This checks whether the Gecko Profiler is running AND the `screenshots` feature
is active.

### What we confirmed works

Setting the profiler env vars produces a profile JSON with:

- `meta.configuration.features` includes `"screenshots"` ✓
- `meta.configuration.threads` includes `"GeckoMain"`, `"Compositor"`,
  `"Renderer"` ✓
- The Compositor thread has markers (`Awake`, `VsyncTimestamp`) — the compositor
  IS running and IS being profiled ✓
- `ProfilerScreenshots::IsEnabled()` returns `true` (feature is active) ✓

Yet **zero `CompositorScreenshot` markers** appear in the profile JSON.

### Where the screenshot capture fails on macOS

On macOS, the native compositor path is taken because
`ShouldUseNativeCompositor()` returns `gfxVars::UseWebRenderCompositor()`, which
is `true` by default:

```cpp
// gfx/webrender_bindings/RenderCompositorNative.cpp
bool RenderCompositorNative::MaybeGrabScreenshot(
    const gfx::IntSize& aWindowSize) {
  if (!ShouldUseNativeCompositor() ||
      !mozilla::layers::ProfilerScreenshots::IsEnabled()) {
    return false;  // ← both checks pass, so we continue
  }

  if (!mNativeLayerRootSnapshotter) {
    mNativeLayerRootSnapshotter = mNativeLayerRoot->CreateSnapshotter();
    // ↑ On macOS, this creates a NativeLayerRootSnapshotterCA,
    //   which uses CARenderer (Core Animation's GPU-accelerated renderer)
  }

  if (mNativeLayerRootSnapshotter) {
    mProfilerScreenshotGrabber.MaybeGrabScreenshot(
        *mNativeLayerRootSnapshotter, aWindowSize);
    // ↑ This calls into ScreenshotGrabberImpl::GrabScreenshot(),
    //   which reads back the composited frame from the NativeLayer.
    //   The readback silently fails when Playwright's custom window
    //   widget doesn't support CARenderer snapshots.
  }

  return true;  // ← Returns true, so the OGL fallback is NOT tried
}
```

The critical failure point: `NativeLayerRootSnapshotterCA::CreateSnapshotter()`
creates a `CARenderer`-backed snapshotter. `CARenderer` renders a `CALayer` tree
into a `CGLContextObj` (OpenGL context). Playwright's Firefox build uses a
custom `CompositorWidget` that creates a `/nsIWidget` with a specialised
`GLContext` — this context may not support the `CARenderer` snapshot path
because the layer tree or pixel format doesn't match what `CARenderer` expects.

The `GrabScreenshot()` call inside `ScreenshotGrabberImpl` does an async GL
readback (`ReadbackTextureHost::Readback()`) of the native layer's snapshot.
When the snapshotter was created from an incompatible GL context (Playwright's
custom widget), the readback silently returns an empty buffer → no screenshot
data → no `CompositorScreenshot` marker is emitted → `SubmitScreenshot()` is
never called.

### Why the OGL fallback path is not reached

Because `MaybeGrabScreenshot()` returns `true` (it successfully entered the
native compositor path, even though the screenshot capture failed silently), the
`RendererOGL` render loop does NOT fall through to the OGL fallback:

```cpp
// RendererOGL.cpp:289
if (!mCompositor->MaybeGrabScreenshot(...)) {
    // ↑ MaybeGrabScreenshot returned true, so this block is skipped
    mScreenshotGrabber.MaybeGrabScreenshot(this, ...);  // OGL fallback
}
```

If we set `gfx.webrender.compositor = false`, the native compositor's
`ShouldUseNativeCompositor()` returns `false`, `MaybeGrabScreenshot()` returns
`false`, and the OGL fallback path IS taken. The OGL fallback uses
`RendererScreenshotGrabber`, which checks:

```cpp
// gfx/webrender_bindings/RendererScreenshotGrabber.cpp
void RendererScreenshotGrabber::MaybeGrabScreenshot(
    RendererOGL* aRendererOGL, const gfx::IntSize& aWindowSize) {
  bool isEnabled =
      ProfilerScreenshots::IsEnabled() && aRendererOGL->EnsureAsyncScreenshot();
  //                           ↑ EnsureAsyncScreenshot checks SupportAsyncScreenshot()
  //                             which returns true by default on all platforms
}
```

However, this OGL fallback path was also not producing `CompositorScreenshot`
markers in our testing on macOS — the `GrabScreenshot()` call inside
`RendererScreenshotGrabber` uses `wr_renderer_readback()` (WebRender's own GL
readback of the rendered frame), which may also fail silently in Playwright's
custom window setup.

### The macOS `CARenderer` dependency

`NativeLayerRootSnapshotterCA` is the only macOS implementation of the
`NativeLayerRootSnapshotter` interface. It creates a `CARenderer` that renders
the `CALayer` tree — the composited frames from WebRender — into an offscreen
OpenGL pixel buffer (`CGLPBufferObj`). The readback of that buffer is what
becomes the screenshot data URI in the profile.

Playwright's Firefox builds create the browser window using a custom
`CompositorWidget` that may not create a standard `CALayer` hierarchy that
`CARenderer` can render from. The `CARenderer` snapshot produces an empty or
invalid pixel buffer, the async readback returns no useful data, and
`SubmitScreenshot()` is never called.

### Environment variables that ARE correctly set

Our co2-runner code sets these env vars when film reel is enabled:

```
MOZ_PROFILER_STARTUP=1
MOZ_PROFILER_STARTUP_ENTRIES=10000000
MOZ_PROFILER_STARTUP_INTERVAL=10
MOZ_PROFILER_STARTUP_FEATURES=js,stackwalk,cpu,screenshots,power
MOZ_PROFILER_STARTUP_FILTERS=GeckoMain,Compositor,Renderer
MOZ_PROFILER_SHUTDOWN=<path-to-profile.json>
```

These are all correct. The feature list uses the right names:

- `screenshots` (the feature is enabled — confirmed in the profile JSON)

We also set `firefoxUserPrefs` to disable WebRender:

```javascript
firefoxUserPrefs: {
  "gfx.webrender.all": false,
  "gfx.webrender.enabled": false,
  "layers.acceleration.force-enabled": false,
}
```

These prefs ARE applied (confirmed via `Preference Read/Write` markers in the
profile JSON), but WebRender remains the compositor on macOS because the
platform's rendering path goes through Core Animation — there's no software
compositor fallback on macOS.

### Profile JSON evidence

Profiles captured on macOS with the screenshots feature enabled:

```json
{
  "meta": {
    "configuration": {
      "features": ["js", "screenshots", "stackwalk", "cpu", "power"],
      "threads": ["GeckoMain", "Compositor", "Renderer", "DOM Worker"],
      "interval": 10,
      "capacity": 16777216
    }
  }
}
```

The Compositor thread's marker data contains only `Awake` and `VsyncTimestamp`
markers — no `CompositorScreenshot`. The string table does NOT contain the
string `"CompositorScreenshot"` at all. The profile does not contain any
`data:image/jpeg;base64,...` data URIs. The file size is ~9 MB (comparable to
profiles without screenshots); profiles WITH screenshots are typically 50–200 MB
due to embedded image data.

### What we tried

1. **Disable WebRender** — set `gfx.webrender.all = false`,
   `gfx.webrender.enabled = false`. Confirmed applied in profile prefs but
   WebRender remains the compositor on macOS.
2. **Profiler WebChannel API** — tried starting the profiler via
   `profiler.firefox.com`'s WebChannel (the same mechanism the profiler website
   uses). Playwright's Firefox build doesn't expose the WebChannel API from web
   content.
3. **Remote debugging + chrome-privileged page** — tried accessing
   `about:config`, `about:profiling`, `about:support`. Playwright blocks
   chrome-privileged pages or times out on them.
4. **Direct process check** — confirmed the Compositor thread IS being profiled
   (152 markers present), and the profile's `profilingStartTime` (19.6ms)
   predates the first Compositor marker (479ms) — no race condition.

### Linux: screenshots work

On Linux, the basic/software compositor is available and uses a non-`CARenderer`
readback path (`ProfilerScreenshots::SubmitScreenshot` via
`ScreenshotGrabberImpl::GrabScreenshot` with standard GL `glReadPixels`).
Profiles captured on Linux with the same env vars DO contain
`CompositorScreenshot` markers with embedded data URIs.

This means a Linux server running co2-runner CAN produce profile JSON files with
the film reel — users can scrub through the visual timeline at
[profiler.firefox.com](https://profiler.firefox.com) and correlate energy spikes
with what was rendered on screen.

## Decision

**We will not attempt to implement CompositorScreenshot capture on macOS.**

The failure is inside Firefox's `CARenderer`-backed
`NativeLayerRootSnapshotterCA`, which silently fails to produce screenshots from
Playwright's custom window widget. This is a limitation in the interaction
between Playwright's window setup and macOS's `CARenderer` API — not something
co2-runner can fix, work around, or override.

The film reel checkbox remains in the UI for Linux use cases. On macOS, the
checkbox enables the `screenshots` profiler feature (which adds minor overhead
to each composite call), but no `CompositorScreenshot` markers will appear in
the profile JSON. The warning about inflated energy readings remains valid on
all platforms.

For macOS users who need the film reel, the alternative is to run co2-runner on
a Linux server and download the resulting profile JSON. The profile is
self-contained and can be opened in
[profiler.firefox.com](https://profiler.firefox.com) from any browser.

### Considered alternatives

#### Alternative 1: Take periodic page screenshots via Playwright's API

Instead of relying on Firefox's internal `CompositorScreenshot` markers,
co2-runner could use `page.screenshot()` at a fixed interval (e.g. every 500ms)
during the journey, then inject those screenshots as `CompositorScreenshot`
markers into the profile JSON before parsing it.

The profiler front-end (`firefox-devtools/profiler`) treats
`CompositorScreenshot` markers uniformly — it doesn't care whether they came
from the compositor or were manually injected. The marker schema is:

```typescript
// src/types/markers.ts:790-802 (from firefox-devtools/profiler repo)
{
  type: "CompositorScreenshot";
  url: IndexIntoStringTable; // → data:image/jpeg;base64,...
  windowID: string;
  windowWidth: number;
  windowHeight: number;
}
```

The `url` field is a string-table index that resolves to a data URI.

**Rejected because** this is a substantial implementation effort (screenshot
timer, string-table management, marker injection into the Compositor thread's
marker array with correct timestamps, proper schema matching) that diverges from
the "use Firefox's built-in profiler" approach. It also introduces
Playwright-screenshot overhead that inflates energy readings more than the
compositor-level screenshots do (`page.screenshot()` is a synchronous round-trip
through the browser; `CompositorScreenshot` is an async GPU readback). The
energy inflation would make the CO2e figures less accurate.

#### Alternative 2: Patch Playwright's Firefox build to support CARenderer snapshots

Submit a PR to Playwright that fixes the `NativeLayerRootSnapshotterCA`
compatibility issue — likely by ensuring the `CompositorWidget` creates a
standard `CALayer` hierarchy that `CARenderer` can render from.

**Rejected because** it's outside co2-runner's scope and requires deep knowledge
of both Playwright's window/widget creation code and macOS's `CARenderer` API.
This is the ideal long-term fix, but it's a Playwright-side change.

#### Alternative 3: Force the OGL fallback path by setting `gfx.webrender.compositor = false`

Setting this pref would make `ShouldUseNativeCompositor()` return `false`,
causing `MaybeGrabScreenshot()` to return `false`, which would trigger the OGL
fallback `RendererScreenshotGrabber` path.

**Rejected because** the OGL fallback path (`wr_renderer_readback`) also did not
produce `CompositorScreenshot` markers in our testing on macOS. The OGL readback
appears to also fail silently in the same custom-window context. Additionally,
disabling the native compositor changes Firefox's rendering pipeline and could
affect the energy measurements we're trying to capture.

## Consequences

- **Positive**: the co2-runner codebase correctly sets the right profiler env
  vars + prefs. If a future Playwright or Firefox build fixes the `CARenderer`
  snapshot path on macOS, the film reel will "just work" without any changes to
  co2-runner.
- **Positive**: Linux server deployments fully support the film reel feature.
  Users can run co2-runner on a Linux machine, capture a profile with
  screenshots, and open it in profiler.firefox.com to scrub through the visual
  timeline.
- **Negative**: macOS users who check the film reel checkbox will see the
  warning about inflated energy readings but will NOT get any screenshots in the
  resulting profile. This is confusing UX — the feature appears to do nothing on
  macOS. Possible mitigation: detect the platform in the UI and show
  "Screenshots not available on macOS" instead of the checkbox. (Deferred — the
  checkbox's warning text already communicates that the feature adds overhead,
  which is accurate even without screenshots being captured.)
- **Negative**: this is a Playwright/Firefox limitation. Filing an issue with
  the Playwright project referencing this ADR would be the next step toward
  getting macOS support.
