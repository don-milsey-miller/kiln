import { CREDENTIAL_SERVICE } from "../connection-services.mjs";
import { STATE_MODE } from "../local-state.mjs";
import { PROJECT_ROOT_ENV, STATE_MODE_ENV } from "../research/permission.mjs";
import { connectionPermission } from "../setup-connections.mjs";
import { resolveVoiceConfig, VOICE_ENV } from "./config.mjs";

/**
 * Resolve the production voice configuration against both halves of onboarding's authority:
 * committed project intent and this host's ignored consent record. Merely setting a credential is
 * never enough for a supervisor-owned run. Calls outside Kiln's supervisor retain the legacy,
 * explicit environment-only contract for the standalone voice checks.
 */
export function resolveProjectVoiceConfig(
  env = process.env,
  { permission = connectionPermission, validators } = {}
) {
  const projectRoot = env[PROJECT_ROOT_ENV];
  if (!projectRoot) return resolveVoiceConfig(env);

  const gate = permission({
    projectRoot,
    stateMode: env[STATE_MODE_ENV] ?? STATE_MODE.PROJECT,
    service: CREDENTIAL_SERVICE.ELEVENLABS,
    env,
    validators,
  });
  if (!gate.permitted) {
    return resolveVoiceConfig(
      { ...env, [VOICE_ENV.enabled]: "false", [VOICE_ENV.ttsMode]: "off" },
      { features: { stt: false, tts: false } }
    );
  }

  const choice = gate.choice;
  return resolveVoiceConfig(
    {
      ...env,
      [VOICE_ENV.enabled]: choice.stt || choice.tts ? "true" : "false",
      ...(choice.voiceId ? { [VOICE_ENV.ttsVoiceId]: choice.voiceId } : {}),
    },
    { features: { stt: choice.stt === true, tts: choice.tts === true } }
  );
}
