import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const AI_TIMEOUT_MS = 120_000
const DONE_RE = /^(completed|complete|closed|done|deployed|delivered|resolved)/i

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function rowsOf(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return []
  const r = parsed?.result ?? parsed
  if (Array.isArray(r)) return r
  for (const key of ['data', 'builds', 'jobs', 'runs']) {
    if (Array.isArray((r as Record<string, unknown>)?.[key])) return (r as Record<string, unknown>)[key] as any[]
  }
  return []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function findStatus(node: unknown, depth = 0): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === 'string') {
    const v = node.trim()
    if (/^(completed|complete|success|succeeded|successful|passed|pass|failed|failure|error|errored|cancelled|canceled|aborted|timeout|timed.?out)/i.test(v)) return v
    return null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findStatus(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (/^(status|state|testresult)$/i.test(key) && typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    for (const value of Object.values(obj)) {
      const hit = findStatus(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function findAgentText(node: unknown, depth = 0): string | null {
  if (node == null || depth > 3) return null
  if (typeof node === 'string') return node.trim() !== '' ? node.trim().slice(0, 2500) : null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['response', 'text', 'answer', 'message', 'content', 'output', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 2500)
    }
    if ('result' in obj) return findAgentText(obj['result'], depth + 1)
  }
  return null
}

export default class ReleaseSprint extends Command {
  static description =
    'Summarize sprint velocity: stories delivered, tests run and promotions across a project.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --project a15xxx',
    '<%= config.bin %> <%= command.id %> --project a15xxx --job 120561 --crt-project 76303 --json',
    '<%= config.bin %> <%= command.id %> --project a15xxx --ai-narrate --json',
  ]

  static flags = {
    project: Flags.string({char: 'p', description: 'Copado project ID scoping the sprint.', required: true}),
    job: Flags.string({char: 'j', description: 'CRT job ID for test evidence. Repeatable.', multiple: true}),
    'crt-project': Flags.string({description: 'CRT project ID used with job IDs.'}),
    'output-dir': Flags.string({char: 'o', description: 'Directory for the sprint files.', default: './sprint-report'}),
    'ai-narrate': Flags.boolean({description: 'Ask the release agent to narrate the sprint. Off by default.', default: false}),
    json: Flags.boolean({description: 'Machine readable stdout summary.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ReleaseSprint)
    const project = flags.project as string
    const jobs = (flags.job as string[] | undefined) ?? []
    const crtProject = (flags['crt-project'] as string | undefined) ?? null
    const outDir = resolve(process.cwd(), (flags['output-dir'] as string) ?? './sprint-report')
    const aiNarrate = (flags['ai-narrate'] as boolean) ?? false
    const asJson = (flags.json as boolean) ?? false
    const notes: string[] = []

    let stories: any[] = []
    try {
      stories = rowsOf(JSON.parse(runAgentia(['cicd', 'work', 'list', '--project-id', project, '--page-size', '100', '--json'])))
      if (stories.length > 100) {
        notes.push(`Story list capped at 100 of ${stories.length}.`)
        stories = stories.slice(0, 100)
      }
    } catch {
      const detail = 'Story listing failed. Check the project ID and authentication.'
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const delivered = stories.filter((s) => DONE_RE.test(str(s.status)))
    const open = stories.filter((s) => !DONE_RE.test(str(s.status)))

    let promotions: any[] = []
    try {
      promotions = rowsOf(
        JSON.parse(runAgentia(['cicd', 'promotion', 'list', '--project-id', project, '--page-size', '50', '--json'])),
      ).slice(0, 50)
    } catch {
      notes.push('Promotion listing failed. Continuing without promotions.')
      promotions = []
    }

    const tests: Array<{job: string; status: string; buildId: string | null}> = []
    if (jobs.length > 0 && crtProject) {
      for (const job of jobs) {
        try {
          const rows = rowsOf(
            JSON.parse(runAgentia(['testing', 'build', 'search', '-p', crtProject, '-j', job, '--page-size', '1', '--json'])),
          )
          const latest = rows[0] ?? null
          const idRaw = latest?.id ?? latest?.buildId ?? latest?.build_id ?? null
          tests.push({job, status: (latest && findStatus(latest)) || 'unknown', buildId: idRaw == null ? null : String(idRaw)})
        } catch {
          tests.push({job, status: 'unreadable', buildId: null})
        }
      }
    } else if (jobs.length > 0) {
      notes.push('Jobs given without --crt-project, skipping test evidence.')
    }

    const greenTests = tests.filter((t) => /^(succeeded|success|passed|pass|completed)/i.test(t.status)).length

    let aiNarration: string | null = null
    if (aiNarrate) {
      const body = JSON.stringify({
        project,
        delivered: delivered.map((s) => str(s.name) || str(s.id)),
        open: open.map((s) => str(s.name) || str(s.id)),
        promotions: promotions.map((p) => ({name: str(p.name) || str(p.id), status: str(p.status)})),
        tests,
      }).slice(0, 10000)
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p',
          `Narrate this sprint for managers in 4 sentences: velocity, what shipped, test health, biggest risk. Data:\n${body}`,
          '--agent', 'release', '--json'], AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiNarration = findAgentText(parsed)
      } catch {
        aiNarration = null
      }
      if (!aiNarration) notes.push('AI narration requested but unavailable. Numbers below still stand.')
    }

    mkdirSync(outDir, {recursive: true})
    const stamp = new Date().toISOString().slice(0, 10)
    const summary = {
      status: 'complete',
      project,
      storyCount: stories.length,
      deliveredCount: delivered.length,
      openCount: open.length,
      delivered: delivered.map((s) => str(s.name) || str(s.id)),
      openStories: open.map((s) => str(s.name) || str(s.id)),
      promotionCount: promotions.length,
      tests,
      greenTests,
      aiNarrateEnabled: aiNarrate,
      aiNarration,
      notes,
    }
    writeFileSync(join(outDir, `SPRINT-${stamp}.json`), JSON.stringify(summary, null, 2), 'utf8')

    const lines: string[] = []
    lines.push(`# Sprint Report, ${project}`)
    lines.push('')
    lines.push(`Generated ${new Date().toISOString()} by agentia release sprint.`)
    lines.push('')
    if (aiNarration) {
      lines.push('## Manager Narrative')
      lines.push('')
      lines.push(aiNarration)
      lines.push('')
    }
    lines.push('## Velocity')
    lines.push('')
    lines.push(`Stories: ${stories.length} total, ${delivered.length} delivered, ${open.length} open.`)
    lines.push(`Promotions tracked: ${promotions.length}.`)
    lines.push(`Test jobs: ${tests.length} read, ${greenTests} green.`)
    lines.push('')
    lines.push('## Delivered')
    lines.push('')
    if (delivered.length === 0) lines.push('Nothing marked delivered in this scope yet.')
    else for (const s of delivered) lines.push(`- ${str(s.name) || str(s.id)}: ${str(s.title)}`)
    lines.push('')
    lines.push('## Open')
    lines.push('')
    if (open.length === 0) lines.push('Backlog clear.')
    else for (const s of open) lines.push(`- ${str(s.name) || str(s.id)}: ${str(s.title)} [${str(s.status)}]`)
    lines.push('')
    lines.push('## Test Evidence')
    lines.push('')
    if (tests.length === 0) lines.push('No test evidence collected. Pass --job plus --crt-project to enable it.')
    else for (const t of tests) lines.push(`- Job ${t.job}: ${t.status}${t.buildId ? ` (build ${t.buildId})` : ''}`)
    if (notes.length > 0) {
      lines.push('')
      lines.push('## Notes')
      lines.push('')
      for (const n of notes) lines.push(`- ${n}`)
    }
    lines.push('')
    const mdFile = join(outDir, `SPRINT-${stamp}.md`)
    writeFileSync(mdFile, lines.join('\n'), 'utf8')

    if (asJson) {
      this.log(JSON.stringify({...summary, files: [mdFile]}, null, 2))
    } else {
      this.log(`Sprint: ${delivered.length} delivered, ${open.length} open, ${greenTests}/${tests.length} test jobs green.`)
      if (aiNarration) this.log(`Narrative: ${aiNarration}`)
      this.log(`Files in ${outDir}.`)
    }
  }
}
