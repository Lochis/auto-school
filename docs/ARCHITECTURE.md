# Architecture (target design, validated 2026-08-19)

## Full pipeline (planned)

```
schedule trigger (Task Scheduler / Graph calendar)
        │
        ▼
Playwright joins Teams meeting (persistent profile from login prototype)
        │
        ▼
recorder: ffmpeg segment muxer ──> seg_000.mp4, seg_001.mp4 ... (5 min each)
        │ segment closes
        ├── frame-extract (~1/10s) + dedupe  [local CPU]
        │       └─ carry last frame hash across segment boundaries
        ├── faster-whisper (segment audio, 1–2s overlap between segments)
        └── deduped frames ──> GLM-4.5V / GLM-4.6V  (Zhipu, batches of 10–20)
        │
        ▼
timeline store: timeline.jsonl  { ts, transcript, slide_content }
        │ at meeting end
        ▼
GLM 5.2 fuses ordered timeline ──> notes.md (hierarchical two-pass if over context)
```

Key decisions:

- **Streaming batches during the meeting** — VLM calls are the slow/expensive
  step; spreading them across the class means notes land ~1–2 min after it
  ends. Failure isolation per segment; bounded disk (delete segments after
  extraction).
- **GLM 5.2 is text-only** — vision pass uses GLM-4.5V/4.6V (same Zhipu key),
  producing per-frame slide/whiteboard text; GLM 5.2 does the final fusion.
  Cheaper local variant: PaddleOCR/Tesseract on frames instead of the VLM.
- **Recording without Teams built-in record**: OS audio loopback (WASAPI/stereo
  mix or virtual audio device) + screen capture, since headless Chromium can't
  grab system audio.
- **Shortcut if org allows it**: enable Teams native recording/transcription and
  pull artifacts via Graph API — removes ffmpeg/loopback entirely.
- **Audio capture**: WASAPI loopback (Windows VM) or PulseAudio loopback sink (Linux).
- **Check school policy on lecture recording** — the real gate, not the tech.

## Login prototype (built)

State-machine poll loop (resilient to selector churn / SSO redirects):

- `launchPersistentContext(user-data)` → goto teams.microsoft.com
- detect: email field → password field → stay-signed-in → account picker
- MFA indicators (selector union + text heuristics) → one Discord webhook ping,
  includes Authenticator number-matching digits → wait `MFA_WAIT_MINUTES`
- success = back on teams.microsoft.com app shell
- persistent profile ⇒ subsequent runs skip password + MFA entirely

Selector drift lives in `src/login/selectors.ts` only.
