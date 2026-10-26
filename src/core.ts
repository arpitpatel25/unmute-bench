/**
 * Unmute Bench — the scoring core.
 *
 * Every AI benchmark measures the model. This one measures the human: how much
 * work a person actually hands to their agents. It reads nothing but the
 * person's own messages to their agents (timestamps and the opening text of
 * each session) and never sends any of it anywhere.
 *
 * Pure functions only. Reading the logs lives in sources.ts, so this file is
 * shared verbatim with the standalone open-source scorer.
 *
 * Metrics, all "per active day" (a day with at least one message), reported as
 * median, trimmed mean (10% off each end) and p90 — never mean or peak, which a
 * single burst can move on its own:
 *
 *   SPD  agent sessions started per active day
 *   MPD  messages to agents per active day
 *   AHD  hours per active day with at least one agent running
 *   PAR  agents running at once, over active minutes
 *   JPH  distinct agents messaged per active hour
 *   TTW  task types touched per week (of 6)
 *
 * Cleaning, applied before any metric (this is what keeps the numbers honest):
 *   1. messages that are machine-written (injected instructions, probes) are
 *      dropped; a session whose every message is machine-written is dropped;
 *   2. sessions whose opening message repeats another's exactly are folded into
 *      the first (scheduled and re-run jobs);
 *   3. bursts — a session started within 60s of three or more others — are
 *      dropped, because a person does not start four agents in a minute; an
 *      automation does.
 */

export type Provider = 'claude' | 'codex'

/** How the session was started. `unmute` is the only label Unmute itself
 *  guarantees; the rest come from the harness's own metadata. */
export type LaunchSource = 'unmute' | 'terminal' | 'desktop-app' | 'sdk' | 'other'

export interface BenchMessage {
  /** Epoch milliseconds. */
  t: number
  text: string
}

export interface BenchSession {
  id: string
  provider: Provider
  source: LaunchSource
  cwd: string
  /** The person's own messages, oldest first. */
  messages: BenchMessage[]
}

export interface Summary {
  median: number
  trimmedMean: number
  p90: number
}

export interface BenchMetrics {
  from: string
  to: string
  activeDays: number
  calendarDays: number
  sessions: number
  messages: number
  spd: Summary
  mpd: Summary
  ahd: Summary
  par: Summary
  jph: Summary
  ttw: number
  taskTypes: Record<TaskType, number>
}

export interface BenchComparison {
  before: BenchMetrics
  after: BenchMetrics
  /** after.median / before.median, null when before is zero. */
  multiplier: { spd: number | null; mpd: number | null; ahd: number | null; jph: number | null }
  /** One-sided rank-sum permutation test: are after-days higher than before-days? */
  pValue: { spd: number; mpd: number }
}

export interface WeekPoint {
  weekStart: string
  activeDays: number
  spd: number
  mpd: number
  ahd: number
}

export interface CleanResult {
  sessions: BenchSession[]
  dropped: { machineOnly: number; duplicates: number; bursts: number }
}

export const TASK_TYPES = ['code', 'research', 'comms', 'content', 'personal', 'other'] as const
export type TaskType = (typeof TASK_TYPES)[number]

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
/** A message keeps its session "running" until the next message, capped here. */
const MAX_LIVE_GAP_MS = 30 * MINUTE_MS
/** After a session's last message in a stretch, assume it ran this long. */
const TAIL_MS = 10 * MINUTE_MS
const BURST_WINDOW_MS = 60_000
const BURST_MAX_NEIGHBOURS = 3

const MACHINE_TEXT = /^\s*(#\s*AGENTS\.md|<[a-z_-]+>|\[Unmute created|Using ONLY|Run exactly|Call the probe|You are (cleaning|a |an |the )|AGENTS\.md)/i
const AUTOMATION_CWD = ['/tmp/', '/private/tmp/', '/routine-sessions/', '/probe']

const TASK_RULES: Array<[TaskType, RegExp]> = [
  ['content', /\b(tweet|twitter|x\.com|instagram|reel|linkedin|youtube|video|caption|thumbnail|followers|viral|post)\b/i],
  ['comms', /\b(email|gmail|inbox|whatsapp|slack|reply|dm|imessage|message|send)\b/i],
  ['code', /\b(code|bug|repo|build|deploy|test|function|api|commit|pr|branch|error|fix|implement|refactor|release|feature|css|server|typescript|python)\b/i],
  ['research', /\b(research|search|compare|analy[sz]e|explain|summari[sz]e|look up|investigate|what is|how does)\b/i],
  ['personal', /\b(flight|travel|passport|visa|calendar|meeting|book|buy|order|price|hotel|bank|doctor|exam|movie|trip)\b/i],
]

export function isMachineText(text: string): boolean {
  return MACHINE_TEXT.test(text)
}

export function classifyTask(openingText: string): TaskType {
  for (const [type, rule] of TASK_RULES) if (rule.test(openingText)) return type
  return 'other'
}

/** Steps 1–3 of the cleaning described at the top of this file. */
export function cleanSessions(input: BenchSession[]): CleanResult {
  let machineOnly = 0
  const withHuman: BenchSession[] = []
  for (const s of input) {
    if (AUTOMATION_CWD.some((p) => s.cwd.includes(p))) { machineOnly++; continue }
    const messages = s.messages.filter((m) => !isMachineText(m.text)).sort((a, b) => a.t - b.t)
    if (messages.length === 0) { machineOnly++; continue }
    withHuman.push({ ...s, messages })
  }

  withHuman.sort((a, b) => a.messages[0].t - b.messages[0].t)
  const seen = new Set<string>()
  const unique: BenchSession[] = []
  let duplicates = 0
  for (const s of withHuman) {
    const key = s.messages[0].text.trim().slice(0, 200)
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    unique.push(s)
  }

  const starts = unique.map((s) => s.messages[0].t)
  const kept: BenchSession[] = []
  let bursts = 0
  for (let i = 0; i < unique.length; i++) {
    const t = starts[i]
    const neighbours = upperBound(starts, t + BURST_WINDOW_MS) - lowerBound(starts, t - BURST_WINDOW_MS)
    if (neighbours > BURST_MAX_NEIGHBOURS) { bursts++; continue }
    kept.push(unique[i])
  }
  return { sessions: kept, dropped: { machineOnly, duplicates, bursts } }
}

/** Metrics over [from, to], both inclusive local dates (YYYY-MM-DD). Messages
 *  outside the window are ignored even when their session started inside it. */
export function computeMetrics(sessions: BenchSession[], from: string, to: string): BenchMetrics {
  const lo = startOfDay(from)
  const hi = startOfDay(to) + DAY_MS
  const sessionsByDay = new Map<string, number>()
  const messagesByDay = new Map<string, number>()
  const hourSessions = new Map<number, Set<string>>()
  const minuteSessions = new Map<number, Set<string>>()
  const weekTypes = new Map<string, Set<TaskType>>()
  const taskTypes = Object.fromEntries(TASK_TYPES.map((k) => [k, 0])) as Record<TaskType, number>
  let sessionCount = 0
  let messageCount = 0

  for (const s of sessions) {
    const inWindow = s.messages.filter((m) => m.t >= lo && m.t < hi)
    if (inWindow.length === 0) continue
    const startedHere = s.messages[0].t >= lo && s.messages[0].t < hi
    if (startedHere) {
      sessionCount++
      bump(sessionsByDay, dayKey(s.messages[0].t))
      const type = classifyTask(s.messages[0].text)
      taskTypes[type]++
      const wk = weekKey(s.messages[0].t)
      if (!weekTypes.has(wk)) weekTypes.set(wk, new Set())
      weekTypes.get(wk)!.add(type)
    }
    for (let i = 0; i < inWindow.length; i++) {
      const m = inWindow[i]
      messageCount++
      bump(messagesByDay, dayKey(m.t))
      const hour = Math.floor(m.t / 3_600_000)
      if (!hourSessions.has(hour)) hourSessions.set(hour, new Set())
      hourSessions.get(hour)!.add(s.id)
      const next = inWindow[i + 1]?.t
      const end = next !== undefined && next - m.t < MAX_LIVE_GAP_MS ? next : m.t + TAIL_MS
      for (let min = Math.floor(m.t / MINUTE_MS); min * MINUTE_MS < end; min++) {
        if (!minuteSessions.has(min)) minuteSessions.set(min, new Set())
        minuteSessions.get(min)!.add(s.id)
      }
    }
  }

  const activeDays = [...new Set([...sessionsByDay.keys(), ...messagesByDay.keys()])].sort()
  const minutesByDay = new Map<string, number>()
  for (const min of minuteSessions.keys()) bump(minutesByDay, dayKey(min * MINUTE_MS))

  return {
    from,
    to,
    activeDays: activeDays.length,
    calendarDays: Math.round((hi - lo) / DAY_MS),
    sessions: sessionCount,
    messages: messageCount,
    spd: summarize(activeDays.map((d) => sessionsByDay.get(d) ?? 0)),
    mpd: summarize(activeDays.map((d) => messagesByDay.get(d) ?? 0)),
    ahd: summarize(activeDays.map((d) => (minutesByDay.get(d) ?? 0) / 60)),
    par: summarize([...minuteSessions.values()].map((v) => v.size)),
    jph: summarize([...hourSessions.values()].map((v) => v.size)),
    ttw: weekTypes.size ? mean([...weekTypes.values()].map((v) => v.size)) : 0,
    taskTypes,
  }
}

export function compare(sessions: BenchSession[], before: [string, string], after: [string, string], permutations = 20_000): BenchComparison {
  const b = computeMetrics(sessions, before[0], before[1])
  const a = computeMetrics(sessions, after[0], after[1])
  const ratio = (x: number, y: number) => (y > 0 ? round(x / y, 1) : null)
  const daily = (from: string, to: string) => dailyCounts(sessions, from, to)
  const db = daily(before[0], before[1])
  const da = daily(after[0], after[1])
  return {
    before: b,
    after: a,
    multiplier: {
      spd: ratio(a.spd.median, b.spd.median),
      mpd: ratio(a.mpd.median, b.mpd.median),
      ahd: ratio(a.ahd.median, b.ahd.median),
      jph: ratio(a.jph.median, b.jph.median),
    },
    pValue: {
      spd: permutationP(db.sessions, da.sessions, permutations),
      mpd: permutationP(db.messages, da.messages, permutations),
    },
  }
}

/** Weekly trend (weeks start Monday) for the in-app chart. */
export function weeklyTrend(sessions: BenchSession[], from: string, to: string): WeekPoint[] {
  const points: WeekPoint[] = []
  let cursor = startOfDay(weekKey(startOfDay(from)))
  const end = startOfDay(to)
  while (cursor <= end) {
    const weekFrom = dayKey(cursor)
    const weekTo = dayKey(Math.min(cursor + 6 * DAY_MS, end))
    const m = computeMetrics(sessions, weekFrom, weekTo)
    if (m.activeDays > 0) points.push({ weekStart: weekFrom, activeDays: m.activeDays, spd: m.spd.median, mpd: m.mpd.median, ahd: round(m.ahd.median, 1) })
    cursor += 7 * DAY_MS
  }
  return points
}

/** The first day a session was started through Unmute — the natural line
 *  between "before" and "after" when the person doesn't set one. */
export function firstUnmuteDay(sessions: BenchSession[]): string | null {
  let first = Infinity
  for (const s of sessions) if (s.source === 'unmute' && s.messages.length) first = Math.min(first, s.messages[0].t)
  return Number.isFinite(first) ? dayKey(first) : null
}

// ── helpers ──

function dailyCounts(sessions: BenchSession[], from: string, to: string): { sessions: number[]; messages: number[] } {
  const lo = startOfDay(from)
  const hi = startOfDay(to) + DAY_MS
  const s = new Map<string, number>()
  const m = new Map<string, number>()
  for (const x of sessions) {
    if (x.messages[0].t >= lo && x.messages[0].t < hi) bump(s, dayKey(x.messages[0].t))
    for (const msg of x.messages) if (msg.t >= lo && msg.t < hi) bump(m, dayKey(msg.t))
  }
  const days = [...new Set([...s.keys(), ...m.keys()])]
  return { sessions: days.map((d) => s.get(d) ?? 0), messages: days.map((d) => m.get(d) ?? 0) }
}

/** One-sided permutation test of "after days are higher than before days",
 *  on the rank sum (Mann–Whitney). Ranks, not medians: a median statistic only
 *  looks at the middle day and has little power on 20–30 days. Seeded, so the
 *  same logs always print the same p. */
export function permutationP(before: number[], after: number[], n: number): number {
  if (!before.length || !after.length) return 1
  const ranks = averageRanks([...before, ...after])
  const sumAfter = (r: number[]) => r.slice(before.length).reduce((a, b) => a + b, 0)
  const observed = sumAfter(ranks)
  // mulberry32
  let rng = 0x2f6b9a3d
  const rand = () => {
    rng = (rng + 0x6d2b79f5) >>> 0
    let x = Math.imul(rng ^ (rng >>> 15), rng | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 0x1_0000_0000
  }
  const pool = [...ranks]
  let hits = 0
  for (let i = 0; i < n; i++) {
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1))
      ;[pool[j], pool[k]] = [pool[k], pool[j]]
    }
    if (sumAfter(pool) >= observed - 1e-9) hits++
  }
  return (hits + 1) / (n + 1)
}

function averageRanks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const ranks = new Array<number>(values.length)
  for (let i = 0; i < order.length;) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2 + 1
    i = j + 1
  }
  return ranks
}

export function summarize(values: number[]): Summary {
  if (!values.length) return { median: 0, trimmedMean: 0, p90: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const cut = Math.floor(sorted.length * 0.1)
  const trimmed = sorted.slice(cut, sorted.length - cut)
  return {
    median: round(median(sorted), 1),
    trimmedMean: round(mean(trimmed.length ? trimmed : sorted), 1),
    p90: round(sorted[Math.floor(0.9 * (sorted.length - 1))], 1),
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function round(x: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function weekKey(t: number): string {
  const d = new Date(t)
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return dayKey(monday.getTime())
}

function startOfDay(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function lowerBound(sorted: number[], x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid }
  return lo
}

function upperBound(sorted: number[], x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid }
  return lo
}
