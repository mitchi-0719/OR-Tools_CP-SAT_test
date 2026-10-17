import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FinishReason, GenerateContentResponse, HttpResponse } from '@google/genai'
import { createApp } from './app.js'
import { createGeminiGenerator, SYSTEM_INSTRUCTION } from './gemini.js'
import { createFileTrace, readTrace, renderTrace } from './trace.js'

const fakeKey = 'secret-key-for-log-tests'
const quiet = () => {}
function sdkResponse(text: string) {
  const response = new GenerateContentResponse()
  response.candidates = [{ content: { role: 'model', parts: [{ text }] }, finishReason: FinishReason.STOP }]
  response.modelVersion = 'test-model'
  response.responseId = 'test-response'
  response.usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
  return response
}

function post(app: ReturnType<typeof createApp>, userMessage: string) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userMessage }),
  })
}

test('trace records exact SDK arguments, readable input, provider metadata and extracted text while masking credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-trace-'))
  try {
    const raw = JSON.stringify({ type: 'answer', message: 'echo ' + fakeKey, actions: [] }, null, 2) + '\n'
    const response = sdkResponse(raw)
    response.sdkHttpResponse = new HttpResponse(new Response('{}'))
    response.sdkHttpResponse.headers = { authorization: 'Bearer another-secret', 'x-goog-api-key': fakeKey, 'set-cookie': 'session-secret' }
    const generate = createGeminiGenerator(async (request) => {
      assert.equal(request.config.systemInstruction, SYSTEM_INSTRUCTION)
      return response
    })
    const app = createApp(generate, undefined, { createTrace: () => createFileTrace({ root, apiKey: fakeKey, report: quiet }) })
    const reply = await post(app, '確認 ' + fakeKey)
    assert.equal(reply.status, 200)
    assert.equal(await reply.text(), raw)
    const traceId = reply.headers.get('X-Trace-Id')!
    const trace = await readTrace(traceId, root)
    const input = JSON.parse(trace.contents['input.json'])
    assert.deepEqual(Object.keys(input), ['context', 'recentMessages', 'pendingProposal', 'userMessage'])
    assert.equal(input.userMessage, '確認 [REDACTED]')
    const request = JSON.parse(trace.contents['request.json'])
    assert.deepEqual(JSON.parse(request.contents[0].parts[0].text), input)
    assert.equal(trace.contents['system.md'], SYSTEM_INSTRUCTION)
    const provider = JSON.parse(trace.contents['response.json'])
    assert.equal(provider.responseId, 'test-response')
    assert.equal(provider.modelVersion, 'test-model')
    assert.equal(provider.usageMetadata.totalTokenCount, 120)
    assert.equal(provider.candidates[0].finishReason, 'STOP')
    assert.equal(provider.sdkHttpResponse.headers.authorization, '[REDACTED]')
    assert.equal(trace.contents['response.txt'], raw.replaceAll(fakeKey, '[REDACTED]'))
    for (const contents of Object.values(trace.contents)) {
      assert.equal(contents.includes(fakeKey), false)
      assert.equal(contents.includes('another-secret'), false)
      assert.equal(contents.includes('session-secret'), false)
    }
    const summary = JSON.parse(trace.contents['trace.json'])
    assert.equal(summary.status, 'completed')
    assert.equal(summary.result.httpStatus, 200)
    assert.equal(summary.result.outputType, 'answer')
    assert.equal(summary.textSource, 'response.text')
    assert.equal(typeof summary.durationMs, 'number')
    assert.equal((await readTrace('latest', root)).traceId, traceId)
    const view = renderTrace(trace)
    assert.match(view, /固定システム指示/)
    assert.match(view, /Gemini SDK のレスポンス/)
    assert.match(view, /response.text の本文/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed API calls retain the sent request and redact the provider error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-trace-error-'))
  try {
    const generate = createGeminiGenerator(async () => { throw Object.assign(new Error('quota ' + fakeKey), { status: 429 }) })
    const app = createApp(generate, undefined, { createTrace: () => createFileTrace({ root, apiKey: fakeKey, report: quiet }) })
    const reply = await post(app, '質問')
    assert.equal(reply.status, 502)
    const trace = await readTrace(reply.headers.get('X-Trace-Id')!, root)
    assert.ok(trace.contents['request.json'])
    const error = JSON.parse(trace.contents['error.json'])
    assert.equal(error.status, 429)
    assert.equal(error.message, 'quota [REDACTED]')
    assert.equal(JSON.parse(trace.contents['trace.json']).status, 'failed')
    assert.equal(trace.contents['response.json'], undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('empty responses retain provider feedback so the lack of text can be investigated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-trace-empty-'))
  try {
    const response = new GenerateContentResponse()
    response.promptFeedback = { blockReasonMessage: 'test feedback' }
    const app = createApp(createGeminiGenerator(async () => response), undefined, {
      createTrace: () => createFileTrace({ root, report: quiet }),
    })
    const reply = await post(app, '質問')
    assert.equal(reply.status, 502)
    const trace = await readTrace(reply.headers.get('X-Trace-Id')!, root)
    assert.equal(JSON.parse(trace.contents['response.json']).promptFeedback.blockReasonMessage, 'test feedback')
    assert.equal(JSON.parse(trace.contents['trace.json']).hasResponseText, false)
    assert.ok(trace.contents['error.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid model output is preserved and its BE validation error is recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-trace-invalid-'))
  try {
    const raw = '{"type":"clarification_required","message":"確認","actions":[{}]}'
    const app = createApp(createGeminiGenerator(async () => sdkResponse(raw)), undefined, {
      createTrace: () => createFileTrace({ root, report: quiet }),
    })
    const reply = await post(app, '質問')
    assert.equal(reply.status, 200)
    assert.equal(await reply.text(), raw)
    assert.equal(reply.headers.get('X-Proposal-Status'), 'invalid_output')
    const trace = await readTrace(reply.headers.get('X-Trace-Id')!, root)
    assert.equal(trace.contents['response.txt'], raw)
    assert.ok(JSON.parse(trace.contents['trace.json']).result.validationError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unavailable storage and response serialization failures do not change the LLM response', async () => {
  const raw = '{"type":"answer","message":"回答","actions":[]}'
  const unavailable = createApp(createGeminiGenerator(async () => sdkResponse(raw)), undefined, {
    createTrace: async () => { throw new Error('not writable') },
  })
  const reply = await post(unavailable, '質問')
  assert.equal(reply.status, 200)
  assert.equal(await reply.text(), raw)
  assert.equal(reply.headers.get('X-Trace-Status'), 'unavailable')
  const root = await mkdtemp(join(tmpdir(), 'gemini-trace-circular-'))
  try {
    const response = sdkResponse(raw)
    Object.assign(response, { circular: response })
    const app = createApp(createGeminiGenerator(async () => response), undefined, {
      createTrace: () => createFileTrace({ root, report: quiet }),
    })
    const traced = await post(app, '質問')
    assert.equal(traced.status, 200)
    assert.equal(await traced.text(), raw)
    const trace = await readTrace(traced.headers.get('X-Trace-Id')!, root)
    assert.equal(trace.contents['response.txt'], raw)
    assert.equal(JSON.parse(trace.contents['trace.json']).status, 'completed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
