import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { MODEL, PORT } from './config.js'
import { createGeminiGenerator } from './gemini.js'
import { createFileTrace } from './trace.js'

const app = createApp(createGeminiGenerator(), undefined, { createTrace: createFileTrace })
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.error('Listening on http://127.0.0.1:' + info.port + ' (model: ' + MODEL + ')')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close())
}
