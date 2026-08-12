function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

export const config = {
  port: num('PORT', 8080),
  // Attendee validates that the websocket URL starts with wss://, so in the cluster
  // TLS is terminated by the nginx ingress in front of this service and the pod
  // itself speaks plain ws.
  wsPath: process.env.WS_PATH ?? '/attendee',

  // Attendee accepts 8000, 16000 or 24000. Google TTS returns whatever rate we ask
  // for, so 24000 everywhere means no resampling anywhere.
  sampleRate: num('SAMPLE_RATE', 24000),

  // Frame size for audio sent back into the meeting. Attendee buffers on its side, so
  // this only decides how big each websocket message is.
  outputFrameMs: num('OUTPUT_FRAME_MS', 20),

  brain: {
    // Who decides what to say:
    //   'auto'     - an external controller if one is connected, otherwise OpenAI
    //   'external' - only an external controller; stay silent when none is connected
    //   'openai'   - always OpenAI, ignore controllers
    mode: (process.env.BRAIN_MODE ?? 'auto') as 'auto' | 'external' | 'openai',
    // Path an external controller connects to. Separate from wsPath, which attendee
    // uses for audio.
    controlPath: process.env.CONTROL_PATH ?? '/control',
    // How long to wait for a controller to answer before giving up on the turn, so a
    // wedged controller cannot make the bot hang mid-conversation.
    timeoutMs: num('BRAIN_TIMEOUT_MS', 60000),
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    // gpt-4o-transcribe and whisper-1 are both available; the former is better.
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe',
    // Latency matters more than depth for a voice turn, so a small model by default.
    chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4.1-mini',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    // Language hint for transcription. Empty lets the model auto-detect, which is
    // slower and occasionally picks the wrong one on short utterances.
    transcribeLanguage: process.env.OPENAI_TRANSCRIBE_LANGUAGE ?? '',
    systemPrompt:
      process.env.AGENT_INSTRUCTIONS ??
      [
        'You are a helpful assistant taking part in a live meeting by voice.',
        'Answer in the language you were addressed in.',
        'Keep replies short and conversational — one or two sentences unless asked for detail.',
        'Your reply is going to be spoken aloud, so do not use markdown, lists or emoji.',
      ].join(' '),
    maxHistoryTurns: num('MAX_HISTORY_TURNS', 20),
  },

  googleTts: {
    // Full service account JSON. Cloud Text-to-Speech rejects API keys outright
    // ("API keys are not supported by this API"), so this has to be a principal.
    serviceAccountJson: required('GOOGLE_TTS_SERVICE_ACCOUNT_JSON'),
    languageCode: process.env.TTS_LANGUAGE_CODE ?? 'ru-RU',
    // Leave empty to let Google pick a voice for the language.
    voiceName: process.env.TTS_VOICE_NAME ?? '',
    speakingRate: num('TTS_SPEAKING_RATE', 1.0),
  },

  vad: {
    // Mean absolute amplitude (0..32767) above which a frame counts as speech.
    // Meeting audio has a noise floor, so this is deliberately not near zero.
    threshold: num('VAD_THRESHOLD', 500),
    // Silence needed to consider an utterance finished.
    hangoverMs: num('VAD_HANGOVER_MS', 700),
    // Utterances shorter than this are treated as noise and dropped.
    minSpeechMs: num('VAD_MIN_SPEECH_MS', 400),
    // Hard cap so one long monologue still gets answered.
    maxUtteranceMs: num('VAD_MAX_UTTERANCE_MS', 20000),
    // The bot may hear its own voice back in the mixed stream. Input stays gated
    // while it speaks, plus this tail, so it does not answer itself.
    selfEchoGuardMs: num('SELF_ECHO_GUARD_MS', 500),
  },

  // Reuses the attendee database: count/postgresqldatabases in jip-quota is 2/2, so
  // there is no slot for a dedicated one. A separate schema keeps these tables away
  // from anything Django migrations manage.
  db: {
    url: required('DATABASE_URL'),
    schema: process.env.DB_SCHEMA ?? 'agent',
  },
} as const;
