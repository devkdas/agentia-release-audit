import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const TERMINAL_RE = /^(completed|complete|success|succeeded|successful|passed|pass|failed|failure|error|errored|cancelled|canceled|aborted|timeout|timed.?out)/i
const AI_TIMEOUT_MS = 120_000

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function rowsOf(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return []
  const r = parsed?.result ?? parsed
  if (Array.isArray(r)) return r
  if (Array.isArray(r?.data)) return r.data
  if (Array.isArray(r?.builds)) return r.builds
  if (Array.isArray(r?.jobs)) return r.jobs
  if (Array.isArray(r?.runs)) return r.runs
  return []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function findStatus(node: unknown, depth = 0): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === 'string') {
    const v = node.trim()
    if (TERMINAL_RE.test(v)) return v
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
      if (/^(status|state|testresult)$/i.test(key) && typeof value === 'string' && value.trim() !== '') {
        return value.trim()
      }
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
  if (typeof node === 'string') return node.trim() !== '' ? node.trim().slice(0, 3000) : null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['response', 'text', 'answer', 'message', 'content', 'output', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 3000)
    }
    if ('result' in obj) return findAgentText(obj['result'], depth + 1)
  }
  return null
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'audit'
}

export default class ReleaseAudit extends Command {
  static description =
    'Aggregate stories, promotions and test evidence into a compliance audit report.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --project a15xxx',
    '<%= config.bin %> <%= command.id %> --project a15xxx --release "Trial" --job 120561 --crt-project 76303',
    '<%= config.bin %> <%= command.id %> --project a15xxx --ai-summary --json',
  ]

  static flags = {
    project: Flags.string({char: 'p', description: 'Copado project ID scoping stories and promotions.'}),
    release: Flags.string({char: 'r', description: 'Release name substring filtering stories.'}),
    job: Flags.string({char: 'j', description: 'CRT job ID for test evidence. Repeatable.', multiple: true}),
    'crt-project': Flags.string({description: 'CRT project ID used with job IDs.'}),
    format: Flags.string({description: 'Report file format.', options: ['md', 'json'], default: 'md'}),
    'output-dir': Flags.string({char: 'o', description: 'Directory for the report files.', default: './release-audit'}),
    'ai-summary': Flags.boolean({description: 'Ask the release agent for an executive summary. Off by default.', default: false}),
    json: Flags.boolean({description: 'Machine readable stdout summary.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ReleaseAudit)
    const project = (flags.project as string | undefined) ?? null
    const release = (flags.release as string | undefined) ?? null
    const jobs = (flags.job as string[] | undefined) ?? []
    const crtProject = (flags['crt-project'] as string | undefined) ?? null
    const format = ((flags.format as string) ?? 'md') as 'md' | 'json'
    const outDir = resolve(process.cwd(), (flags['output-dir'] as string) ?? './release-audit')
    const aiEnabled = (flags['ai-summary'] as boolean) ?? false
    const asJson = (flags.json as boolean) ?? false

    if (!project && !release && jobs.length === 0) {
      const detail = 'Pass at least one scope: --project, --release, or --job.'
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    mkdirSync(outDir, {recursive: true});
    const notes: string[] = []

    let stories: any[] = []
    try {
      const args = ['cicd', 'work', 'list', '--page-size', '100', '--json']
      if (project) args.push('--project-id', project)
      stories = rowsOf(JSON.parse(runAgentia(args)))
      if (release) {
        const needle = release.toLowerCase()
        stories = stories.filter((s) => `${str(s.releaseName)} ${str(s.releaseId)}`.toLowerCase().includes(needle))
      }
      if (stories.length > 50) {
        notes.push(`Story list capped at 50 of ${stories.length} for report size.`)
        stories = stories.slice(0, 50)
      }
    } catch {
      notes.push('Story listing failed. Continuing with an empty story set.')
      stories = []
    }

    let promotions: any[] = []
    if (project) {
      try {
        promotions = rowsOf(
          JSON.parse(runAgentia(['cicd', 'promotion', 'list', '--project-id', project, '--page-size', '50', '--json'])),
        ).slice(0, 20)
      } catch {
        notes.push('Promotion listing failed. Continuing without promotions.')
        promotions = []
      }
    } else {
      notes.push('No --project given, skipping promotions section.')
    }

    const tests: Array<{job: string; status: string; buildId: string | null}> = []
    if (jobs.length > 0 && crtProject) {
      for (const job of jobs) {
        try {
          const rows = rowsOf(
            JSON.parse(runAgentia(['testing', 'build', 'search', '-p', crtProject, '-j', job, '--page-size', '1', '--json'])),
          )
          const latest = rows[0] ?? null
          const status = (latest && findStatus(latest)) || 'unknown'
          const idRaw = latest?.id ?? latest?.buildId ?? latest?.build_id ?? null
          tests.push({job, status, buildId: idRaw == null ? null : String(idRaw)})
        } catch {
          tests.push({job, status: 'unreadable', buildId: null})
        }
      }
    } else if (jobs.length > 0) {
      notes.push('Jobs given without --crt-project, skipping test evidence. Add --crt-project to enable it.')
    }

    const gates: Array<{story: string; status: string}> = []
    for (const story of stories.slice(0, 10)) {
      const label = str(story.name) || str(story.id) || 'unknown'
      try {
        const out = runAgentia(['gov', 'check', '--story', label, '--env', 'UAT-SFP', '--json'], 45_000)
        const parsed = JSON.parse(out)
        gates.push({story: label, status: str(parsed?.status) || 'unknown'})
      } catch {
        gates.push({story: label, status: 'unknown (gov plugin unavailable or check failed)'})
      }
    }
    if (stories.length > 10) notes.push('Gov re-checks capped at the first 10 stories.')

    let aiSummary: string | null = null
    if (aiEnabled) {
      const aggregate = {
        release: release ?? null,
        project,
        stories: stories.map((s) => ({name: str(s.name), title: str(s.title), status: str(s.status)})),
        promotions: promotions.map((p) => ({name: str(p.name), status: str(p.status)})),
        tests,
        gates,
      }
      const body = JSON.stringify(aggregate).slice(0, 12000)
      const prompt =
        `You are an IT auditor. Summarize this Salesforce release for a business stakeholder in plain English: ` +
        `what shipped, whether tests are green, and any risks or blockers. Aggregate:\n${body}`
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'release', '--json'], AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiSummary = findAgentText(parsed)
      } catch {
        aiSummary = null
      }
      if (!aiSummary) notes.push('AI summary requested but unavailable. Report carries raw evidence only.')
    }

    const tag = slug(release ?? project ?? 'audit')
    const stamp = new Date().toISOString().slice(0, 10)
    const base = `AUDIT-${tag}-${stamp}`
    const summary = {
      status: 'complete',
      release: release ?? null,
      project,
      storyCount: stories.length,
      promotionCount: promotions.length,
      tests,
      gates,
      aiSummaryEnabled: aiEnabled,
      aiSummary,
      notes,
    }

    writeFileSync(join(outDir, `${base}.json`), JSON.stringify(summary, null, 2), 'utf8')
    let reportFile: string | null = null
    if (format === 'md') {
      const lines: string[] = []
      lines.push(`# Release Audit, ${release ?? project ?? 'scope'}`)
      lines.push('')
      lines.push(`Generated ${new Date().toISOString()} by agentia release audit.`)
      lines.push('')
      if (aiSummary) {
        lines.push('## Executive Summary')
        lines.push('')
        lines.push(aiSummary)
        lines.push('')
      }
      lines.push('## Stories')
      lines.push('')
      if (stories.length === 0) lines.push('No stories matched this scope.')
      else for (const s of stories) lines.push(`- ${str(s.name) || str(s.id)}: ${str(s.title)} [${str(s.status)}]`)
      lines.push('')
      lines.push('## Promotions')
      lines.push('')
      if (promotions.length === 0) lines.push('No promotions listed for this scope.')
      else for (const p of promotions) lines.push(`- ${str(p.name) || str(p.id)} [${str(p.status)}]`)
      lines.push('')
      lines.push('## Test Evidence')
      lines.push('')
      if (tests.length === 0) lines.push('No test evidence collected. Pass --job plus --crt-project to enable it.')
      else for (const t of tests) lines.push(`- Job ${t.job}: ${t.status}${t.buildId ? ` (build ${t.buildId})` : ''}`)
      lines.push('')
      lines.push('## Governance Check')
      lines.push('')
      if (gates.length === 0) lines.push('No policy gates evaluated.')
      else for (const g of gates) lines.push(`- ${g.story}: ${g.status}`)
      if (notes.length > 0) {
        lines.push('')
        lines.push('## Notes')
        lines.push('')
        for (const n of notes) lines.push(`- ${n}`)
      }
      lines.push('')
      reportFile = join(outDir, `${base}.md`)
      writeFileSync(reportFile, lines.join('\n'), 'utf8')
    }

    if (asJson) {
      this.log(JSON.stringify({...summary, reportFile}, null, 2))
    } else {
      this.log(`Audit complete: ${stories.length} stories, ${promotions.length} promotions, ${tests.length} test jobs.`)
      if (aiSummary) this.log(`AI summary: ${aiSummary}`)
      this.log(`Files in ${outDir}${reportFile ? ` (${reportFile})` : ''}.`)
      for (const n of notes) this.log(`Note: ${n}`)
    }
  }
}
