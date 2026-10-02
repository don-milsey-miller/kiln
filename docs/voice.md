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

