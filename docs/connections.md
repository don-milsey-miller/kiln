# Connections and capabilities

The guided setup groups optional services separately from the AI model Kiln uses for planning:

| Service | Capability | Credential identity |
| --- | --- | --- |
| Tavily | Public-web research | `TAVILY_API_KEY` |
| OpenAI | Audio transcription and remote PDF/image extraction | `OPENAI_API_KEY` |
| ElevenLabs | Voice dictation and speech output | `ELEVENLABS_API_KEY` |
| TypeSafe Jev | Advisory semantic decisioning | `TYPESAFE_API_KEY` |

A credential and permission are different facts. Finding a credential never enables a capability.
Kiln records non-secret project intent in `.pi/kiln.json` and this computer's approval in the ignored
local consent record. Both must agree at runtime. A clone receives neither a secret nor another
computer's approval.

## Credential storage

Interactive setup can use an existing environment variable or store a newly entered credential in
the operating system's credential vault. The vault entry is scoped to one service. If the system
vault is unavailable, setup offers Configure later or Skip; it never falls back to a plaintext file.
Environment variables take precedence over vault entries for automation and CI.

Secrets are not written to planning content, `.pi/kiln.json`, setup journals, command arguments, or
terminal output. Setup reviews all connection choices before it stores a newly entered credential or
changes project/consent records.

At runtime, Kiln checks project intent and this computer's consent before asking the credential
broker for the one service credential an approved adapter needs. The resolved value stays in that
adapter's process environment; it is never added to project state or rendered in the browser,
terminal, or model context.

## Runtime authorization

- Tavily probes `/usage` only after explicit approval and performs no search during setup.
- OpenAI receives source bytes only when project intent and host consent both authorize remote
  processing. Local text and text-bearing PDF ingestion remain available when it is skipped.
- ElevenLabs STT and TTS can be chosen independently. TTS requires an explicit Voice ID, not the API
  key. Find it in ElevenLabs by opening **Voices**, selecting the voice Kiln should use, and copying
  its **Voice ID**. Missing FFmpeg, FFplay, or physical audio hardware makes voice unavailable without
  failing core setup.
- Jev uses its model-list authentication probe during setup. It remains advisory and gains no
  permission to write, approve, or bypass a deterministic gate.

Rerun `node .planning/bin/setup.mjs` to change a connection choice. For automation, set only the
needed environment variables and use explicit setup flags. The advanced `decisioning:configure`
command remains available for Jev-only administration.

## Recovery

Cancellation before the review applies no connection choice. A failed probe reports that connection
as incomplete or failed while preserving completed core setup. Rerunning setup is safe: committed
choices and host grants are read back, and no completed side effect is silently inferred from the
presence of a credential.
