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

