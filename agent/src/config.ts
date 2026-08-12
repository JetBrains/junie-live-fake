function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Attendee validates that the websocket URL starts with wss://, so in the cluster
  // TLS is terminated by the nginx ingress in front of this service and the pod
  // itself speaks plain ws.
  wsPath: process.env.WS_PATH ?? '/attendee',

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    // Overridable because Realtime model ids move fast.
    model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1',
    baseUrl: process.env.OPENAI_REALTIME_URL ?? 'wss://api.openai.com/v1/realtime',
    voice: process.env.OPENAI_VOICE ?? 'marin',
    instructions:
      process.env.AGENT_INSTRUCTIONS ??
      [
        'You are a helpful assistant joining a live meeting by voice.',
        'Keep replies short and conversational — one or two sentences unless asked for detail.',
        'You are hearing a mixed audio stream of every participant, so more than one person may speak.',
        'If you are unsure whether you were addressed, stay quiet.',
      ].join(' '),
  },

  // Attendee supports 8000, 16000 and 24000. The OpenAI Realtime API speaks PCM16
  // mono at 24000, so 24000 lets audio pass through untouched in both directions.
  sampleRate: Number(process.env.SAMPLE_RATE ?? 24000),

  // Reuses the attendee database: count/postgresqldatabases in jip-quota is 2/2, so
  // there is no slot for a dedicated one. A separate schema keeps these tables away
  // from anything Django migrations manage.
  db: {
    url: required('DATABASE_URL'),
    schema: process.env.DB_SCHEMA ?? 'agent',
  },
} as const;
