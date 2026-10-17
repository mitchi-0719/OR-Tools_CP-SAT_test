import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AIChatOutput } from './types.js'

test('terminal conversation preserves raw output and applies ID/settings approvals through BE', { timeout: 15000 }, async (t) => {
  const output: AIChatOutput = {
    type: 'approval_required',
    message: 'Everythingを第2部に配置する条件を追加します。',
    actions: [{
      type: 'add_constraint',
      constraint: {
        type: 'in_range',
        targets: { band_ids: ['band-003'] },
        params: { kind: 'parts', part_ids: [1] },
        hardness: null,
        priority: null,
      },
    }],
  }
  const answer: AIChatOutput = { type: 'answer', message: '適用済み1件', actions: [] }
  const dir = await mkdtemp(join(tmpdir(), 'gemini-cli-'))
  try {
    // 同じ Hono アプリへ fetch を接続し、実 API と TCP 待受なしで CLI 全体を動かす。
    const preloader = join(dir, 'backend.mjs')
    await writeFile(preloader, [
      'import assert from "node:assert/strict"',
      'import { createApp } from ' + JSON.stringify(new URL('./app.ts', import.meta.url).href),
      'const app = createApp(async (input) => {',
      '  console.error("TEST:LLM_CALLED")',
      '  if (input.userMessage === "条件を確認") {',
      '    assert.equal(input.context.constraints.length, 1)',
      '    assert.equal(input.context.constraints[0].hardness, "soft")',
      '    assert.equal(input.context.constraints[0].priority, "high")',
      '    assert.equal(input.pendingProposal, null)',
      '    return JSON.stringify(' + JSON.stringify(answer) + ')',
      '  }',
      '  return JSON.stringify(' + JSON.stringify(output) + ')',
      '})',
      'globalThis.fetch = (url, init) => app.request(new URL(String(url)).pathname, init)',
    ].join('\n'))
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--import', preloader,
      fileURLToPath(new URL('./cli.ts', import.meta.url)), '--interactive',
    ], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    t.after(() => child.kill())
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text })
      child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end('Everythingを第2部にしたい\n/approve data/approval-settings.example.json\n条件を確認\n/exit\n')
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, JSON.stringify(output) + JSON.stringify(answer), result.stderr)
    assert.match(result.stderr, /承認した制約を BE の現在状態に反映しました/)
    const sent = [...result.stderr.matchAll(/---LLMに送る内容---/g)].map((match) => match.index!)
    const called = [...result.stderr.matchAll(/TEST:LLM_CALLED/g)].map((match) => match.index!)
    const received = [...result.stderr.matchAll(/---LLMからのレスポンス---/g)].map((match) => match.index!)
    assert.equal(sent.length, 2)
    assert.equal(called.length, 2)
    assert.equal(received.length, 2)
    for (let index = 0; index < 2; index++) {
      assert.ok(sent[index] < called[index], '送信内容は LLM 呼び出し前に表示する')
      assert.ok(called[index] < received[index], '受信見出しは LLM の応答後に表示する')
    }
    assert.match(result.stderr, /\[systemInstruction\]/)
    assert.match(result.stderr, /\[contents: 入力 JSON\]/)
    assert.match(result.stderr, /"currentPlacements": \[\]/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
