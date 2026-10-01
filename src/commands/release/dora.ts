import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function rowsOf(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return []
  const r = parsed?.result ?? parsed
  if (Array.isArray(r)) return r
  if (Array.isArray(r?.data)) return r.data
  return []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function weekKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = (monday.getUTCDay() + 6) % 7
  monday.setUTCDate(monday.getUTCDate() - day)
  return monday.toISOString().slice(0, 10)
}

export default class ReleaseDora extends Command {
  static description =
    'DORA style KPIs from promotion plus story history: frequency, failure rate and lead time.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --project a15xxx',
    '<%= config.bin %> <%= command.id %> --project a15xxx --weeks 8 --json',
  ]

  static flags = {
    project: Flags.string({char: 'p', description: 'Copado project ID scoping metrics.', required: true}),
    weeks: Flags.integer({char: 'w', description: 'Weeks of history analyzed.', default: 4}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ReleaseDora)
    const project = flags.project as string
    const weeks = Math.max(1, Math.min(26, (flags.weeks as number) ?? 4))
    const asJson = (flags.json as boolean) ?? false
    const notes: string[] = []

    let promotions: any[] = []
    try {
      promotions = rowsOf(
        JSON.parse(runAgentia(['cicd', 'promotion', 'list', '--project-id', project, '--page-size', '100', '--json'])),
      ).slice(0, 100)
    } catch {
      const detail = 'Promotion listing failed. Check the project ID and authentication.'
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    let stories: any[] = []
    try {
      stories = rowsOf(
        JSON.parse(runAgentia(['cicd', 'work', 'list', '--project-id', project, '--page-size', '100', '--json'])),
      ).slice(0, 100)
    } catch {
      notes.push('Story listing failed. Lead time computed without story dates.')
      stories = []
    }

    const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000
    const dateOf = (p: any): number => {
      for (const key of ['createdDate', 'created', 'createdAt', 'date', 'lastModifiedDate']) {
        const t = Date.parse(str(p?.[key]))
        if (!Number.isNaN(t)) return t
      }
      return NaN
    }
    const inRange = promotions.filter((p) => {
      const t = dateOf(p)
      return !Number.isNaN(t) && t >= cutoff
    })
    const datedCount = inRange.length
    const undated = promotions.length - datedCount
    if (undated > 0) notes.push(`${undated} promotions carry no parseable date and were excluded from time math.`)

    const failed = inRange.filter((p) => /^(failed|failure|error)/i.test(str(p?.status))).length
    const byWeek = new Map<string, number>()
    for (const p of inRange) {
      const w = weekKey(new Date(dateOf(p)).toISOString())
      if (w !== '') byWeek.set(w, (byWeek.get(w) ?? 0) + 1)
    }
    const frequency = datedCount / weeks

    const storyById = new Map<string, any>()
    for (const s of stories) {
      const id = str(s?.id)
      if (id !== '') storyById.set(id, s)
    }
    const leadDays: number[] = []
    let linked = 0
    for (const p of inRange) {
      const wid = str(p?.workId || p?.work_id || p?.userStoryId || p?.storyId)
      const story = wid !== '' ? storyById.get(wid) : undefined
      const t0 = story ? dateOf(story) : NaN
      const t1 = dateOf(p)
      if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 >= t0) {
        linked += 1
        leadDays.push((t1 - t0) / 86400000)
      }
    }
    leadDays.sort((x, y) => x - y)
    const medianLead = leadDays.length === 0 ? null
      : leadDays.length % 2 === 1 ? leadDays[(leadDays.length - 1) / 2]
      : (leadDays[leadDays.length / 2 - 1] + leadDays[leadDays.length / 2]) / 2
    if (inRange.length > 0 && linked === 0) {
      notes.push('No promotion linked to a dated story, so lead time is unmeasurable here. Median needs story to promotion linkage.')
    }

    const payload = {
      status: 'complete',
      project,
      weeks,
      deploymentFrequencyPerWeek: Math.round(frequency * 100) / 100,
      promotionsInRange: datedCount,
      changeFailureRatePct: datedCount === 0 ? 0 : Math.round((failed / datedCount) * 100),
      medianLeadTimeDays: medianLead === null ? null : Math.round(medianLead * 100) / 100,
      linkedStories: linked,
      weeklyCounts: [...byWeek.entries()].sort().map(([week, count]) => ({week, count})),
      notes,
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`DORA for ${project} over ${weeks} weeks: ${payload.deploymentFrequencyPerWeek} deploys per week, ${payload.changeFailureRatePct}% change failure, median lead ${medianLead === null ? 'unmeasurable' : `${medianLead} days`}.`)
      for (const [week, count] of [...byWeek.entries()].sort()) this.log(`  ${week}: ${count} promotions.`)
      for (const n of notes) this.log(`Note: ${n}`)
    }
  }
}
