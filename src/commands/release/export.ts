import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

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

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface TraceRow {
  story: string
  title: string
  status: string
  dataCommits: string
  tests: string
  promotion: string
  gate: string
}

export default class ReleaseExport extends Command {
  static description =
    'Export a compliance traceability pack: story to commit to test to promotion to approval.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --project a15xxx',
    '<%= config.bin %> <%= command.id %> --project a15xxx --job 120561 --crt-project 76303 --format html',
  ]

  static flags = {
    project: Flags.string({char: 'p', description: 'Copado project ID scoping the export.', required: true}),
    release: Flags.string({char: 'r', description: 'Release name substring filtering stories.'}),
    job: Flags.string({char: 'j', description: 'CRT job ID for test evidence. Repeatable.', multiple: true}),
    'crt-project': Flags.string({description: 'CRT project ID used with job IDs.'}),
    format: Flags.string({description: 'Export file format.', options: ['html', 'md'], default: 'html'}),
    'output-dir': Flags.string({char: 'o', description: 'Directory for the export files.', default: './compliance-export'}),
    json: Flags.boolean({description: 'Machine readable stdout summary.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ReleaseExport)
    const project = flags.project as string
    const release = (flags.release as string | undefined) ?? null
    const jobs = (flags.job as string[] | undefined) ?? []
    const crtProject = (flags['crt-project'] as string | undefined) ?? null
    const format = ((flags.format as string) ?? 'html') as 'html' | 'md'
    const outDir = resolve(process.cwd(), (flags['output-dir'] as string) ?? './compliance-export')
    const asJson = (flags.json as boolean) ?? false

    let stories: any[] = []
    try {
      stories = rowsOf(JSON.parse(runAgentia(['cicd', 'work', 'list', '--project-id', project, '--page-size', '100', '--json'])))
      if (release) {
        const needle = release.toLowerCase()
        stories = stories.filter((s) => `${str(s.releaseName)} ${str(s.releaseId)}`.toLowerCase().includes(needle))
      }
      stories = stories.slice(0, 50)
    } catch {
      const detail = 'Story listing failed. Check the project ID and authentication.'
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    let promotions: any[] = []
    try {
      promotions = rowsOf(
        JSON.parse(runAgentia(['cicd', 'promotion', 'list', '--project-id', project, '--page-size', '50', '--json'])),
      ).slice(0, 20)
    } catch {
      promotions = []
    }

    const testByJob = new Map<string, string>()
    if (jobs.length > 0 && crtProject) {
      for (const job of jobs) {
        try {
          const rows = rowsOf(
            JSON.parse(runAgentia(['testing', 'build', 'search', '-p', crtProject, '-j', job, '--page-size', '1', '--json'])),
          )
          const latest = rows[0] ?? null
          const idRaw = latest?.id ?? latest?.buildId ?? null
          testByJob.set(job, `${(latest && findStatus(latest)) || 'unknown'}${idRaw == null ? '' : ` (build ${String(idRaw)})`}`)
        } catch {
          testByJob.set(job, 'unreadable')
        }
      }
    }

    const rows: TraceRow[] = []
    for (const story of stories) {
      const label = str(story.name) || str(story.id) || 'unknown'
      const sid = str(story.id) || label
      let dataCommits = 'not checked'
      try {
        const commits = rowsOf(JSON.parse(runAgentia(['cicd', 'data', 'commit', 'list', sid, '--json'])))
        dataCommits = commits.length === 0 ? 'none' : commits.map((c) => str(c.name) || str(c.id) || 'commit').slice(0, 5).join(', ');
      } catch {
        dataCommits = 'unreadable'
      }
      let gate = 'not evaluated'
      try {
        const out = runAgentia(['gov', 'check', '--story', label, '--env', 'UAT-SFP', '--json'], 45000)
        gate = str(JSON.parse(out)?.status) || 'unknown'
      } catch {
        gate = 'unknown (gov unavailable)'
      }
      rows.push({
        story: label,
        title: str(story.title),
        status: str(story.status) || 'unknown',
        dataCommits,
        tests: jobs.length === 0 ? 'no jobs scoped' : [...testByJob.entries()].map(([j, s]) => `${j}=${s}`).join('; '),
        promotion: promotions.length === 0 ? 'none listed' : promotions.slice(0, 3).map((p) => `${str(p.name) || str(p.id)} [${str(p.status)}]`).join('; '),
        gate,
      })
    }

    mkdirSync(outDir, {recursive: true})
    const stamp = new Date().toISOString().slice(0, 10)
    const base = `TRACE-${((release ?? project).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scope').slice(0, 50)}-${stamp}`

    const summary = {
      status: 'complete',
      project,
      release,
      rows,
      rowCount: rows.length,
      format,
    }
    writeFileSync(join(outDir, `${base}.json`), JSON.stringify(summary, null, 2), 'utf8')

    let file: string
    if (format === 'html') {
      const trs = rows.map((r) =>
        `<tr><td>${escHtml(r.story)}</td><td>${escHtml(r.title)}</td><td>${escHtml(r.status)}</td>` +
        `<td>${escHtml(r.dataCommits)}</td><td>${escHtml(r.tests)}</td><td>${escHtml(r.promotion)}</td><td>${escHtml(r.gate)}</td></tr>`,
      ).join('\n');
      const html =
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Compliance Traceability ${escHtml(release ?? project)}</title>` +
        `<style>body{font-family:sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:.4rem;text-align:left}th{background:#eee}caption{text-align:left;font-size:1.2rem;font-weight:bold;margin-bottom:.5rem}</style></head><body>` +
        `<table><caption>Traceability matrix, generated ${new Date().toISOString()} by agentia release export</caption>` +
        `<tr><th>Story</th><th>Title</th><th>Status</th><th>Data commits</th><th>Tests</th><th>Promotions</th><th>Gate</th></tr>${trs}</table>` +
        `<p>Rows: ${rows.length}. Generated evidence, not a certification. Review every row before sign-off.</p></body></html>`;
      file = join(outDir, `${base}.html`)
      writeFileSync(file, html, 'utf8')
    } else {
      const lines = [`# Traceability, ${release ?? project}`, '', `Generated ${new Date().toISOString()} by agentia release export.`, '']
      for (const r of rows) {
        lines.push(`- ${r.story}: ${r.title} [${r.status}] | commits: ${r.dataCommits} | tests: ${r.tests} | promotions: ${r.promotion} | gate: ${r.gate}`)
      }
      lines.push('', 'Rows: ' + rows.length + '. Generated evidence, not a certification.')
      file = join(outDir, `${base}.md`)
      writeFileSync(file, lines.join('\n'), 'utf8')
    }

    if (asJson) {
      this.log(JSON.stringify({...summary, file}, null, 2))
    } else {
      this.log(`Traceability export complete: ${rows.length} stories into ${file}.`)
    }
  }
}
