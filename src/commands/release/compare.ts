import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
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

export default class ReleaseCompare extends Command {
  static description =
    'Side by side diff of two release audits across time or environments. Fully offline.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --from AUDIT-a-2026-09-29.json --to AUDIT-a-2026-10-01.json',
    '<%= config.bin %> <%= command.id %> --from a.json --to b.json --output-dir ./compare --json',
  ]

  static flags = {
    from: Flags.string({description: 'Older audit JSON file.', required: true}),
    to: Flags.string({description: 'Newer audit JSON file.', required: true}),
    'output-dir': Flags.string({char: 'o', description: 'Directory for the comparison files.', default: './release-compare'}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ReleaseCompare)
    const outDir = resolve(process.cwd(), (flags['output-dir'] as string) ?? './release-compare')
    const asJson = (flags.json as boolean) ?? false

    let a: any
    let b: any
    try {
      a = JSON.parse(readFileSync(resolve(process.cwd(), flags.from as string), 'utf8'))
      b = JSON.parse(readFileSync(resolve(process.cwd(), flags.to as string), 'utf8'))
    } catch (error: any) {
      const detail = `Could not read audit files: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const keyOf = (s: any): string => str(s?.name) || str(s?.id) || JSON.stringify(s).slice(0, 80)
    const aStories = new Map<string, any>()
    for (const s of (Array.isArray(a?.stories) ? a.stories : rowsOf(a))) {
      if (typeof s === 'object' && s !== null) aStories.set(keyOf(s), s)
      else if (typeof s === 'string') aStories.set(s, {name: s})
    }
    const bStories = new Map<string, any>()
    for (const s of (Array.isArray(b?.stories) ? b.stories : rowsOf(b))) {
      if (typeof s === 'object' && s !== null) bStories.set(keyOf(s), s)
      else if (typeof s === 'string') bStories.set(s, {name: s})
    }

    const addedStories = [...bStories.keys()].filter((k) => !aStories.has(k))
    const removedStories = [...aStories.keys()].filter((k) => !bStories.has(k))
    const changedStatus: Array<{story: string; from: string; to: string}> = []
    for (const [k, sb] of bStories) {
      const sa = aStories.get(k)
      if (sa && str(sa?.status) !== str(sb?.status)) {
        changedStatus.push({story: k, from: str(sa?.status) || 'unknown', to: str(sb?.status) || 'unknown'})
      }
    }

    const testDelta = (doc: any): Array<{job: string; status: string}> => {
      const t = Array.isArray(doc?.tests) ? doc.tests : []
      return t.map((x: any) => ({job: str(x?.job), status: str(x?.status)}))
    }
    const regs: string[] = []
    for (const t of testDelta(b)) {
      const old = testDelta(a).find((x) => x.job === t.job)
      if (!old) regs.push(`${t.job} is new in this audit (${t.status})`)
      else if (/^(succeeded|success|passed|pass|completed)$/i.test(old.status) && /^(failed|failure|error)/i.test(t.status)) {
        regs.push(`${t.job} regressed from ${old.status} to ${t.status}`)
      }
    }

    mkdirSync(outDir, {recursive: true})
    const stamp = new Date().toISOString().slice(0, 10)
    const payload = {
      status: regs.length > 0 ? 'regressed' : addedStories.length + removedStories.length + changedStatus.length > 0 ? 'changed' : 'identical',
      addedStories,
      removedStories,
      changedStatus,
      regressions: regs,
    }
    writeFileSync(join(outDir, `COMPARE-${stamp}.json`), JSON.stringify(payload, null, 2), 'utf8')

    const lines = [
      `# Release comparison`,
      '',
      `Compared ${new Date().toISOString()} by agentia release compare.`,
      '',
      `Stories added: ${addedStories.length}, removed: ${removedStories.length}, status changed: ${changedStatus.length}.`,
      '',
      ...regs.map((r) => `- REGRESSION: ${r}`),
      ...changedStatus.map((c) => `- ${c.story}: ${c.from} to ${c.to}`),
      '',
    ]
    const mdFile = join(outDir, `COMPARE-${stamp}.md`)
    writeFileSync(mdFile, lines.join('\n'), 'utf8')

    if (asJson) {
      this.log(JSON.stringify({...payload, file: mdFile}, null, 2))
    } else {
      if (regs.length > 0) for (const r of regs) this.log(`REGRESSION: ${r}`)
      this.log(`Compared: +${addedStories.length} stories, -${removedStories.length} removed, ~${changedStatus.length} status changes. Report at ${mdFile}.`)
    }
    if (regs.length > 0) this.exit(1)
  }
}
