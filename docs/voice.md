# Voice development

Kiln's first microphone backend uses the `ffmpeg` executable with its OpenAL input device. The
backend is optional: if FFmpeg, OpenAL support, microphone permission, or an input device is absent,
voice capture is unavailable while the rest of Kiln continues to operate.

## Audio contract

Capture is streamed through stdout as headerless `pcm_16000`: mono signed 16-bit little-endian PCM
at 16 kHz. Kiln does not create a recording file. The backend enforces both elapsed-time and byte
bounds and terminates FFmpeg when capture is stopped, cancelled, or disposed.

FFmpeg documents OpenAL capture, its default-device behavior, and device enumeration in the
[input-device manual](https://ffmpeg.org/ffmpeg-devices.html#openal). Kiln invokes the fixed
`ffmpeg` executable with an argument array and `shell: false`; a configured device name remains one
argument and cannot become a shell command or an FFmpeg option.

## Supported hosts

- Windows: validated with an OpenAL-enabled FFmpeg build. With no configured input, OpenAL chooses
  its default capture device.
- Linux: requires an FFmpeg build with the OpenAL input device and a working OpenAL capture backend
  (commonly PulseAudio or PipeWire compatibility). With no configured input, OpenAL chooses its
  default capture device.
- macOS: intentionally deferred; the backend currently reports the platform as unsupported.

Confirm that the installed executable advertises `D  openal`:

```text
ffmpeg -hide_banner -devices
```

List the device names FFmpeg exposes:

```text
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
$env:ELEVENLABS_API_KEY = [Environment]::GetEnvironmentVariable("ELEVENLABS_API_KEY", "User")
$env:KILN_TTS_VOICE_ID = "your-voice-id"
npm run test:voice:tts:live -- "Kiln live synthesis check."
Remove-Item Env:KILN_VOICE_LIVE_TEST, Env:ELEVENLABS_API_KEY, Env:KILN_TTS_VOICE_ID
```

ElevenLabs accepts `enable_logging=false` only for eligible Zero Retention Mode accounts. Kiln asks
for that mode, but operators must confirm their account policy rather than treating the request as a
retention guarantee.

### Opt-in live STT check

The live check is excluded from CI. It sends an existing headerless, mono 16 kHz signed 16-bit
little-endian PCM file to ElevenLabs, prints the committed transcript and retention status, and
does not write provider audio or responses to disk.

PowerShell on Windows:

```powershell
$env:KILN_VOICE_LIVE_TEST = "1"
$env:ELEVENLABS_API_KEY = [Environment]::GetEnvironmentVariable("ELEVENLABS_API_KEY", "User")
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

