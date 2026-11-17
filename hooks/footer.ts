import type { EngineInterface } from 'claude-code'

import type { Footer, FooterIssue } from '../types'

// Footer of the pane: a stats line (lines of code · commits · issues) and the open GitHub issues.
// Everything comes from the session's own directory; nothing is ever written into the repository.

const GIT_MS = 10_000
const LINES_MS = 30_000

export const DEFAULT_EXT = 'ts tsx mts cts js jsx mjs cjs swift kt kts java py go rs rb php c h cc cpp hpp m mm cs vue svelte css scss sql sh'.split(' ')
export const DEFAULT_EXCLUDE = ['dist/', 'build/', 'out/', '.next/', 'vendor/', 'node_modules/', 'generated/', '__generated__/', '*.min.*', '*.d.ts', '*.pb.*', '*.g.*', '*.generated.*']
const MAX_BYTES = 1_048_576

export type StatsConfig = { extensions?: string[]; exclude?: string[]; maxFileBytes?: number }

type Run = { exitCode: number; stdout: string }
async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs = GIT_MS, stdin?: string): Promise<Run | null> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs, ...(stdin !== undefined ? { stdin } : {}) })
    // stderr is never shown or logged: gh can print account details there
    return { exitCode: r.exitCode, stdout: r.stdout }
  } catch {
    return null
  }
}

const globToRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')

function excluder(rules: string[]) {
  const dirs = rules.filter(r => r.endsWith('/'))
  const names = rules.filter(r => !r.endsWith('/')).map(globToRe)
  return (path: string) => {
    const p = '/' + path
    if (dirs.some(d => p.includes('/' + d))) return true
    const base = path.slice(path.lastIndexOf('/') + 1)
    return names.some(re => re.test(base))
  }
}

// Lines of code at HEAD (not the working tree), so the number depends only on what is committed.
// Physical lines as `wc -l` counts them, with a last line lacking its newline counted too: `git grep -c ''`.
// `git grep -I` skips binary files (a NUL byte in the content), the same test as the spec's.
export async function countLines($: EngineInterface, cwd: string, cfg: StatsConfig): Promise<number | null> {
  const exts = new Set((cfg.extensions?.length ? cfg.extensions : DEFAULT_EXT).map(e => e.replace(/^\./, '').toLowerCase()))
  const isExcluded = excluder([...DEFAULT_EXCLUDE, ...(cfg.exclude ?? [])])
  const maxBytes = cfg.maxFileBytes ?? MAX_BYTES

  const tree = await run($, ['git', 'ls-tree', '-r', '-l', '-z', 'HEAD'], cwd, LINES_MS)
  if (!tree || tree.exitCode !== 0) return null
  const keep: string[] = []
  for (const rec of tree.stdout.split('\0')) {
    // "<mode> blob <sha> <size>\t<path>"
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const meta = rec.slice(0, tab).trim().split(/\s+/)
    const path = rec.slice(tab + 1)
    if (meta[1] !== 'blob') continue
    const size = Number(meta[3])
    const dot = path.lastIndexOf('.')
    if (dot < 0 || path.lastIndexOf('/') > dot) continue
    if (!exts.has(path.slice(dot + 1).toLowerCase())) continue
    if (!(size <= maxBytes) || isExcluded(path)) continue
    keep.push(path)
  }
  if (!keep.length) return 0

  // linguist-generated / linguist-vendored from .gitattributes, in one call
  const attrs = await run($, ['git', 'check-attr', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'], cwd, LINES_MS, keep.join('\0') + '\0')
  const marked = new Set<string>()
  if (attrs && attrs.exitCode === 0) {
    const f = attrs.stdout.split('\0')
    for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] === 'set' || f[i + 2] === 'true') marked.add(f[i] as string)
  }
  const wanted = new Set(keep.filter(p => !marked.has(p)))

  const grep = await run($, ['git', 'grep', '-I', '-c', '-z', '-e', '', 'HEAD', '--'], cwd, LINES_MS)
  if (!grep || (grep.exitCode !== 0 && grep.exitCode !== 1)) return null
  let total = 0
  for (const line of grep.stdout.split('\n')) {
    // "HEAD:<path>\0<count>"
    const nul = line.indexOf('\0')
    if (nul < 0) continue
    const path = line.slice(0, nul).replace(/^HEAD:/, '')
    if (wanted.has(path)) total += Number(line.slice(nul + 1)) || 0
  }
  return total
}

// The project a directory belongs to: the main checkout of its git repository (worktrees share it), else the directory.
const projects = new Map<string, string>()
export async function projectKey($: EngineInterface, cwd: string): Promise<string> {
  const hit = projects.get(cwd)
  if (hit) return hit
  const r = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  const dir = r && r.exitCode === 0 ? r.stdout.trim() : ''
  const key = dir ? dir.replace(/\/\.git\/?$/, '') : cwd
  projects.set(cwd, key)
  return key
}
export const projectName = (key: string) => key.replace(/\/+$/, '').split('/').pop() || key

export type Probe = { git: boolean; owner?: string; name?: string }
export async function probe($: EngineInterface, cwd: string): Promise<Probe> {
  const inside = await run($, ['git', 'rev-parse', '--is-inside-work-tree'], cwd)
  if (!inside || inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return { git: false }
  const repo = await run($, ['gh', 'repo', 'view', '--json', 'owner,name'], cwd)
  if (!repo || repo.exitCode !== 0) return { git: true }
  try {
    const j = JSON.parse(repo.stdout) as { owner?: { login?: string }; name?: string }
    return j.owner?.login && j.name ? { git: true, owner: j.owner.login, name: j.name } : { git: true }
  } catch {
    return { git: true }
  }
}

export async function headSha($: EngineInterface, cwd: string) {
  const r = await run($, ['git', 'rev-parse', 'HEAD'], cwd)
  return r && r.exitCode === 0 ? r.stdout.trim() : null
}

export async function commitCount($: EngineInterface, cwd: string) {
  const r = await run($, ['git', 'rev-list', '--count', 'HEAD'], cwd)
  const n = r && r.exitCode === 0 ? Number(r.stdout.trim()) : NaN
  return Number.isFinite(n) ? n : null
}

const QUERY = 'query($o:String!,$r:String!){repository(owner:$o,name:$r){url issues{totalCount} open:issues(states:OPEN){totalCount}}}'
export async function issues($: EngineInterface, cwd: string, owner: string, name: string): Promise<Pick<Footer, 'repoUrl' | 'issuesTotal' | 'openCount' | 'open'> | null> {
  const [counts, list] = await Promise.all([
    run($, ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-F', `o=${owner}`, '-F', `r=${name}`], cwd),
    run($, ['gh', 'issue', 'list', '--state', 'open', '--limit', '8', '--json', 'number,title,url,createdAt'], cwd),
  ])
  if (!counts || counts.exitCode !== 0 || !list || list.exitCode !== 0) return null
  try {
    const r = (JSON.parse(counts.stdout) as { data?: { repository?: { url: string; issues: { totalCount: number }; open: { totalCount: number } } } }).data?.repository
    if (!r) return null
    const open = (JSON.parse(list.stdout) as FooterIssue[]).map(i => ({ number: i.number, title: i.title, url: i.url, createdAt: i.createdAt }))
    return { repoUrl: r.url, issuesTotal: r.issues.totalCount, openCount: r.open.totalCount, open }
  } catch {
    return null
  }
}

// 9.3 万 / 1,684 / 1.2 亿
export function fmtCount(n: number) {
  if (n < 10_000) return n.toLocaleString('en-US')
  const one = (x: number) => String(Math.round(x * 10) / 10).replace(/\.0$/, '')
  if (n < 100_000_000) return `${one(n / 10_000)} 万`
  return `${one(n / 100_000_000)} 亿`
}

export function age(createdAt: string, now = new Date()) {
  const c = new Date(createdAt)
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((day(now) - day(c)) / 86_400_000)
  if (!(days >= 1)) return '今天'
  if (days < 60) return `${days} 天`
  return `${Math.floor(days / 30)} 个月`
}
