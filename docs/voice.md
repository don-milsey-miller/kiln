# Voice development

Kiln's microphone backend uses the `ffmpeg` executable with DirectShow on Windows and OpenAL on
Linux. The backend is optional: if FFmpeg, the host capture backend, microphone permission, or an
input device is absent, voice capture is unavailable while the rest of Kiln continues to operate.

## Configuration and clean setup

Voice uses the ElevenLabs credential named by `ELEVENLABS_API_KEY`. This credential is independent
of Pi's model provider authentication: Kiln neither reads a Pi credential for voice nor sends the
ElevenLabs key to Pi. Install `ffmpeg` and `ffplay` on `PATH`, using an FFmpeg build with DirectShow
on Windows or OpenAL on Linux, then start Kiln from an environment containing the settings you want.

The normal path is `node .planning/bin/setup.mjs`: choose ElevenLabs, select STT, TTS, or both, and
provide a voice ID when TTS is selected. Setup stores a pasted credential only in the operating
system credential vault. In a supervisor-owned run, project intent and this host's consent gate voice
even when `ELEVENLABS_API_KEY` is present. The environment table below remains the advanced and CI
configuration contract.

| Setting | Default | Meaning |
| --- | --- | --- |
| `KILN_VOICE_ENABLED` | `false` | Enables operator-invoked voice controls in the Pi TUI. |
| `ELEVENLABS_API_KEY` | none | Required for ElevenLabs STT and TTS. Keep it out of Git and project files. |
| `KILN_STT_PROVIDER` / `KILN_TTS_PROVIDER` | `elevenlabs` | V1 provider selection; no other provider is supported. |
| `KILN_STT_MODEL` | `scribe_v2_realtime` | Realtime transcription model. |
| `KILN_TTS_MODEL` | `eleven_flash_v2_5` | Speech-synthesis model. |
| `KILN_TTS_VOICE_ID` | none | Required explicit ElevenLabs voice ID for output. |
| `KILN_TTS_MODE` | `off` | Startup output mode. `/voice output on` is a session-only override. |
| `KILN_ELEVENLABS_ENABLE_LOGGING` | `false` | Explicitly permit ElevenLabs request logging. Required for TTS on accounts without Zero Retention Mode. |
| `KILN_VOICE_INPUT_DEVICE` / `KILN_VOICE_OUTPUT_DEVICE` | system defaults | Exact host device overrides. |
| `KILN_VOICE_MAX_RECORDING_MS` | `120000` | Per-recording limit; hard maximum is 300000 ms. |
| `KILN_TTS_MAX_CHARACTERS` | `4000` | Per-response renderer limit; hard maximum is 20000 characters. |

PowerShell example:

```powershell
$keySecure = Read-Host "Paste temporary ElevenLabs API key" -AsSecureString
$keyCredential = New-Object System.Management.Automation.PSCredential("unused", $keySecure)
$env:ELEVENLABS_API_KEY = $keyCredential.GetNetworkCredential().Password
Remove-Variable keySecure, keyCredential

$env:KILN_VOICE_ENABLED = "true"
$env:KILN_TTS_VOICE_ID = "your-voice-id"
node .planning/bin/start-kiln.mjs
```

The PowerShell key is scoped to that window and its child processes. Do not put the key directly in
the command line, PowerShell history, a repository file, or chat.

Linux shell example:

```bash
KILN_VOICE_ENABLED=true \
ELEVENLABS_API_KEY='temporary-key' \
KILN_TTS_VOICE_ID='your-voice-id' \
node .planning/bin/start-kiln.mjs
```

`/voice status` reports STT and TTS independently. Missing credentials, provider failures, and
input/output hardware failures remain voice-only errors; they do not end Pi or change the planning
session. `/voice devices` lists microphone choices known to FFmpeg's host capture backend. Output-device discovery
depends on the host audio backend, so use its exact device name when overriding the default.

## Audio contract

Capture is streamed through stdout as headerless `pcm_16000`: mono signed 16-bit little-endian PCM
at 16 kHz. Kiln does not create a recording file. The backend enforces both elapsed-time and byte
bounds and terminates FFmpeg when capture is stopped, cancelled, or disposed.

FFmpeg documents DirectShow and OpenAL capture and device enumeration in the
[input-device manual](https://ffmpeg.org/ffmpeg-devices.html). Kiln invokes the fixed
`ffmpeg` executable with an argument array and `shell: false`; a configured device name remains one
argument and cannot become a shell command or an FFmpeg option.

## Supported hosts

- Windows: requires an FFmpeg build with the DirectShow input device. With no configured input,
  Kiln selects the first audio device FFmpeg enumerates; use `KILN_VOICE_INPUT_DEVICE` to choose a
  different device by its exact displayed name.
- Linux: requires an FFmpeg build with the OpenAL input device and a working OpenAL capture backend
  (commonly PulseAudio or PipeWire compatibility). With no configured input, OpenAL chooses its
  default capture device.
- macOS: intentionally deferred; the backend currently reports the platform as unsupported.

Confirm that the installed executable advertises `D  dshow` on Windows or `D  openal` on Linux:

```text
ffmpeg -hide_banner -devices
```

List the device names FFmpeg exposes:

```powershell
# Windows
ffmpeg -hide_banner -list_devices true -f dshow -i dummy
```

```bash
# Linux
ffmpeg -hide_banner -list_devices true -f openal -i dummy
```

Set `KILN_VOICE_INPUT_DEVICE` to an exact listed capture-device name to override the default.

## Opt-in hardware check

This check acquires the microphone for up to three seconds, counts in-memory PCM, reports its peak,
and discards it. It neither contacts ElevenLabs nor writes audio to disk. It is never part of
ordinary CI.

PowerShell on Windows:

```powershell
$env:KILN_VOICE_HARDWARE_TEST = "1"
npm run test:voice:hardware
Remove-Item Env:KILN_VOICE_HARDWARE_TEST
```

Linux shell:

```bash
KILN_VOICE_HARDWARE_TEST=1 npm run test:voice:hardware
```

To test a non-default device, set `KILN_VOICE_INPUT_DEVICE` to its exact listed name in the same
environment.

## ElevenLabs realtime transcription

Kiln's STT adapter consumes only the canonical `pcm_16000` stream above. It exchanges the
long-lived `ELEVENLABS_API_KEY` for a short-lived, single-use realtime Scribe token over HTTPS,
then opens the provider WebSocket with `commit_strategy=manual`. Audio is sent only when an
operator starts listening, and stopping sends an explicit commit. Partial and committed
transcripts remain distinct events; the adapter does not edit or submit prompt text.

The adapter asks ElevenLabs for `enable_logging=false`, but that request is not a guarantee of zero
retention. ElevenLabs documents [Zero Retention Mode](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode)
as an Enterprise feature. Until the provider confirms otherwise, Kiln reports
`zero-retention-requested-unconfirmed`; if ElevenLabs warns that the session is still logged, Kiln
reports `logging-active` and surfaces a sanitized warning.

## TUI dictation

Voice is deliberately available only in Pi's interactive TUI. Enable it and provide an independent
ElevenLabs credential before starting Kiln:

```text
KILN_VOICE_ENABLED=true
ELEVENLABS_API_KEY=your-temporary-key
```

The `/voice` command supports:

```text
/voice start    begin microphone capture
/voice stop     stop capture and manually commit the transcript
/voice status   show bounded STT/TTS and lifecycle status
/voice devices  list FFmpeg/OpenAL microphone choices
/voice output on   speak finalized assistant responses
/voice output off  stop current speech and clear queued responses
```

`Ctrl+Shift+V` toggles between start and stop. It is a toggle, not push-and-hold; terminal key-release
events are not portable enough for hold-to-talk behavior.

Partial recognition appears only in Kiln's voice widget. A committed transcript is appended to
whatever is in Pi's editor when finalization completes, including text typed while recognition was
running. It remains an editable draft: Kiln never presses Enter, sends the message, or answers a
confirmation dialog. The operator must review the transcript and submit it normally.

Ctrl+C retains its existing meaning: it stops the Kiln/Pi run. It is not a voice toggle. Voice
failures affect the voice status only and do not add any model-visible tool.

Speech output defaults to off (`KILN_TTS_MODE=off`). An operator may enable it for the current Pi
session with `/voice output on`, or opt in at startup with `KILN_TTS_MODE=on`; both require
`KILN_TTS_VOICE_ID`. Only Pi's finalized assistant text is eligible. System content, user content,
tool calls, tool results, and partial assistant tokens are never enqueued. Starting `/voice start`
or using the voice shortcut first cancels current playback and its queue, then starts the microphone;
it does not abort the Pi agent. `/voice output off` likewise affects output only, leaving STT and the
session running.

## Local speech playback

Kiln's playback boundary uses `ffplay` on supported Windows and Linux hosts. Synthesized signed
16-bit PCM is streamed directly to the player's standard input; Kiln does not create an audio file.
The system default output is used unless `KILN_VOICE_OUTPUT_DEVICE` supplies a validated SDL/host
audio device hint. Playback can be stopped immediately and a session shutdown terminates any
remaining player process. Physical speaker validation is part of the final voice validation ticket.

Before text reaches a speech provider, Kiln deterministically renders only finalized assistant prose.
System prompts, tool calls, tool results, hidden reasoning, and non-text blocks are excluded. Markdown
formatting is removed, link labels remain while destinations are omitted, and tables, structured data,
code blocks, raw URLs, and file paths become short spoken markers. Requirement and artifact identifiers
such as `REQ-0009` are spoken as `REQ 0009`. The renderer does not call a model or alter Pi's transcript,
and its output is bounded by `KILN_TTS_MAX_CHARACTERS`.

ElevenLabs speech synthesis uses the configured `KILN_TTS_VOICE_ID` and defaults to
`eleven_flash_v2_5`. Kiln requests mono 24 kHz signed 16-bit PCM and keeps the response in memory
only long enough to pass it to the provider-neutral playback boundary. A bounded FIFO queue performs
synthesis and playback outside Pi's event callback. Cancellation stops current work, disposal owns
both provider and player cleanup, and one failed item does not prevent later queued speech.

The live synthesis check is excluded from CI and never saves the returned audio:

```powershell
$env:KILN_VOICE_LIVE_TEST = "1"
$env:KILN_TTS_VOICE_ID = "your-voice-id"
npm run test:voice:tts:live -- --play "Kiln live synthesis check."
Remove-Item Env:KILN_VOICE_LIVE_TEST, Env:ELEVENLABS_API_KEY, Env:KILN_TTS_VOICE_ID
```

ElevenLabs accepts `enable_logging=false` only for eligible Zero Retention Mode accounts. Kiln asks
for that mode by default. Set `KILN_ELEVENLABS_ENABLE_LOGGING=true` only when explicitly accepting
provider-side request retention; operators must confirm their account policy rather than treating
any request setting as a retention guarantee.

### Opt-in live STT check

The live check is excluded from CI. It sends an existing headerless, mono 16 kHz signed 16-bit
little-endian PCM file to ElevenLabs, prints the committed transcript and retention status, and
does not write provider audio or responses to disk.

PowerShell on Windows:

```powershell
$env:KILN_VOICE_LIVE_TEST = "1"
npm run test:voice:stt:live -- C:\path\to\sample.pcm
Remove-Item Env:KILN_VOICE_LIVE_TEST, Env:ELEVENLABS_API_KEY
```

Linux shell:

```bash
KILN_VOICE_LIVE_TEST=1 ELEVENLABS_API_KEY='temporary-key' \
  npm run test:voice:stt:live -- /path/to/sample.pcm
```

Use a temporary, least-privilege key and revoke it after the check. Do not commit keys or audio
fixtures.

## Physical audio validation

These checks are deliberately manual and opt in to microphone, provider, and speaker access. Run
them from a clean checkout after `npm ci`. Speak a harmless phrase; never speak a credential or
private project content. Both checks keep PCM in memory and do not create an audio file.

### Windows

1. Confirm `ffmpeg -hide_banner -devices` includes `D  dshow`, and confirm `ffplay -version` runs.
2. Put a temporary ElevenLabs key in the current PowerShell process using the secure prompt in the
   configuration example. Keep that window open for every live check.
3. Run the microphone-to-STT check, speak a short phrase for five seconds, and confirm the committed
   transcript is intelligible:

   ```powershell
   $env:KILN_VOICE_LIVE_TEST = "1"
   $env:KILN_VOICE_HARDWARE_TEST = "1"
   npm run test:voice:stt:hardware-live
   ```

4. Set a voice ID, synthesize a harmless phrase, and confirm it is audible and intelligible through
   the expected output device:

   ```powershell
   $env:KILN_ELEVENLABS_ENABLE_LOGGING = "true" # required unless the account has Zero Retention Mode
   $env:KILN_TTS_VOICE_ID = "your-voice-id"
   npm run test:voice:tts:live -- --play "Kiln Windows speaker check."
   ```

5. Start Kiln with voice enabled. Exercise every `/voice` command, the `Ctrl+Shift+V` toggle,
   concurrent typing during dictation, output interruption by `/voice start`, and repeated shutdown.
   Confirm Ctrl+C still stops Kiln/Pi and spoken `yes` never answers a confirmation dialog.
6. Clear the process variables. Revoke the temporary key after validation is complete.

### Linux

1. Confirm the OpenAL input device and `ffplay` are available. Confirm the selected PulseAudio or
   PipeWire compatibility layer can see the intended microphone and speaker.
2. Run the microphone and speaker checks:

   ```bash
   KILN_VOICE_LIVE_TEST=1 KILN_VOICE_HARDWARE_TEST=1 \
     ELEVENLABS_API_KEY='temporary-key' npm run test:voice:stt:hardware-live

   KILN_VOICE_LIVE_TEST=1 ELEVENLABS_API_KEY='temporary-key' \
     KILN_TTS_VOICE_ID='your-voice-id' \
     npm run test:voice:tts:live -- --play "Kiln Linux speaker check."
   ```

3. Repeat the Pi TUI exercises in the Windows step and record the distribution, desktop/session
   audio backend, FFmpeg version, and result in #113 before signoff.

macOS validation is deferred. Kiln's V1 capture/playback boundary reports macOS as unsupported; no
macOS support claim should be made until its backend and full matrix are established and tested.

## Regression evidence

The automated suite uses injected fake microphone, STT, TTS, and playback boundaries. Physical
audibility and intelligibility remain the two manual host checks above.

| # | Required behavior | Automated evidence |
| --- | --- | --- |
| 1 | Registration acquires no resource or credential | `pi-package.test.mjs`, `voice.test.mjs` |
| 2 | Voice is TUI-only | `voice-dictation.test.mjs` |
| 3 | No voice model tool is registered | `voice.test.mjs`, package signature checks |
| 4 | Partial STT never edits the editor | `voice-end-to-end.test.mjs` |
| 5 | Final STT preserves concurrent typing | `voice-end-to-end.test.mjs` |
| 6 | STT never submits | `voice-end-to-end.test.mjs` |
| 7 | Spoken yes cannot approve | `voice-end-to-end.test.mjs` |
| 8 | Ctrl+C semantics are unchanged | `keyboard-stop.test.mjs`, `voice-dictation.test.mjs` |
| 9 | Dictation interrupts only TTS | `voice-end-to-end.test.mjs` |
| 10 | Pi callback does not await TTS | `voice-output.test.mjs`, `voice-dictation.test.mjs` |
| 11 | Tool/system content is silent | `voice-speech-text.test.mjs`, `voice-output.test.mjs` |
| 12 | Provider failures stay voice-only | `voice-stt-elevenlabs.test.mjs`, `voice-tts-elevenlabs.test.mjs` |
| 13 | Hardware failures stay voice-only | `voice-capture.test.mjs`, `voice-playback.test.mjs` |
| 14 | Credentials never enter observable state | `voice-config.test.mjs`, provider adapter tests |
| 15 | Repeated disposal is safe | `voice-end-to-end.test.mjs`, `voice.test.mjs` |
| 16 | Recording shutdown closes resources | `voice-end-to-end.test.mjs`, `voice-dictation.test.mjs` |
| 17 | Speaking shutdown stops synthesis/playback | `voice-end-to-end.test.mjs` |
| 18 | Kiln persists no input/output audio | capture, playback, and provider adapter tests |
| 19 | Recording duration is bounded | `voice-capture.test.mjs` |
| 20 | Rendered text and queue are bounded | `voice-speech-text.test.mjs`, `voice-tts-elevenlabs.test.mjs` |
| 21 | STT works when TTS is unavailable | `voice-output.test.mjs` |
| 22 | TTS can be disabled independently | `voice-output.test.mjs` |
| 23 | Repeated cycles release resources | `voice-end-to-end.test.mjs`, capture/playback tests |

