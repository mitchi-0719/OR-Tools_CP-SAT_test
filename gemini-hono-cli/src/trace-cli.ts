import './config.js'
import { readTrace, renderTrace } from './trace.js'

try {
  const identifier = process.argv[2] ?? 'latest'
  process.stdout.write(renderTrace(await readTrace(identifier)))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
