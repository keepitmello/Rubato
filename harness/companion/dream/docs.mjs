// The dream's second job: document upkeep. The first job (dream.mjs) folds the companion's days into
// its memory; this one tends the documents the user named in the companion's settings
// (`dream.docs.roots`, companion.mjs): one canonical place per topic, a repeated rule kept there and
// replaced elsewhere by a one-line link, a document that disagrees with the code reported rather than
// guessed, and the text rewritten to the prompting-lab standard (docs.md is the job's instructions).
//
// It runs after the memory dream on the same night, as its own model run with its own watermark
// (`blocks.docs` in dream/state.json) and cadence (`dream.docs.cadence`), so a slow or failing docs
// run never costs the memory dream its night. What it may change is held in code, not only asked:
//
//   edit    a place inside the companion's home. The run works on a copy of the home, and only the
//           memory dream's own places (memory/, notes/, minus the resident piece) inside the root come
//           back, merged three ways and committed in the home, as the memory dream's do.
//   branch  a place in a git repository. The run works in a detached worktree of the repository at
//           its current commit, under the run's folder. Afterwards Rubato, not the model, commits
//           what changed inside the root onto a new `dream/docs-YYYYMMDD` branch and removes the
//           worktree; the branch waits for review. The checkout the user works in, its branches and
//           its remotes are never written, and nothing is pushed.
//   report  read only.
//
// A file locked with the immutable flag (chflags uchg, like a locked money canonical document) is
// locked in the copy too, any change to it is put back, and the report names it. A change outside the
// roots is put back and named. A repository or report folder that changed while the run went is named
// in the report: the run cannot tell the dream's hand from the user's, so a person looks.
//
// Each run leaves a short report at <home>/dream/docs/YYYY-MM-DD.md: what changed where, the branches,
// what a person has to decide. The control tower puts one DOCS_REPORT line under the companion's
// next heartbeat tick (docsReportLine), so the companion reads it when it wakes and tells the user.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { companionDefaultsDir } from '../../rubato-pi/src/system-prompt.mjs';
import { docsRootPath, docsRootProblem, memoryPiecePath } from '../companion.mjs';
import { commitOwned, ensureHomeRepo, landsInside, localDate, segnoPaths } from '../home.mjs';
import { CHILD_TIMEOUT_MS, DREAM_MODELS, WRITABLE, bringHome, childArgs, composeDreamPrompt, dreamPaths, lastLine, localIso,
  materialize, readDreamState, readJson, readText, releaseLock, snapshot, spawnLogged, takeLock, workEnv, writeJson } from './dream.mjs';

/** Hours between docs runs per cadence, a little under the day, week and four weeks (as dream.mjs CADENCE_HOURS). */
export const DOCS_CADENCE_HOURS = Object.freeze({ daily: 20, weekly: 160, monthly: 640 });
export const DOCS_BRANCH_PREFIX = 'dream/docs-';
const INSTRUCTIONS = path.join(import.meta.dirname, 'docs.md');
/** A report folder outside git is fingerprinted by its files' sizes and times, up to this many. */
const FINGERPRINT_FILE_LIMIT = 20_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
/** Git without hooks or prompts: the dream's own worktree and commit run nothing of the repository's. */
const GIT_QUIET = ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

const round1 = (value) => Math.round(value * 10) / 10;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const posix = (rel) => rel.split(path.sep).join('/');
const inScope = (rel, scopes) => scopes.some((scope) => scope === '' || rel === scope || rel.startsWith(`${scope}/`));
const real = (file) => { try { return realpathSync(file); } catch { return undefined; } };

export function docsReportDir(env = process.env) {
  return path.join(dreamPaths(env).dir, 'docs');
}

/**
 * Whether the docs job runs tonight: it has roots, its cadence is not off, and its cadence has passed
 * since it last ran (a first run is due at once). A manual run is due whenever there are roots.
 */
export function docsDue({ at, state = {}, settings, manual = false }) {
  const docs = settings?.dream?.docs ?? {};
  const roots = Array.isArray(docs.roots) ? docs.roots : [];
  const lastAt = state.blocks?.docs?.lastAt ?? null;
  if (!roots.length) return { due: false, lastAt, reason: 'no docs roots set' };
  if (docs.cadence === 'off' && !manual) return { due: false, lastAt, reason: 'docs upkeep is off' };
  const last = Date.parse(lastAt ?? '');
  const everyHours = DOCS_CADENCE_HOURS[docs.cadence] ?? DOCS_CADENCE_HOURS.weekly;
  if (manual || !Number.isFinite(last)) return { due: true, lastAt, everyHours, elapsedH: Number.isFinite(last) ? round1((at - last) / 3_600_000) : null };
  const elapsedH = round1((at - last) / 3_600_000);
  return elapsedH >= everyHours ? { due: true, lastAt, everyHours, elapsedH }
    : { due: false, lastAt, everyHours, elapsedH, reason: `ran ${elapsedH}h ago, every ${everyHours}h` };
}

function git(cwd, args, { input, allowFail = false, env: extra = {} } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...GIT_QUIET, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra } });
  } catch (error) {
    if (allowFail) return undefined;
    throw new Error(`git ${args[0]} in ${cwd}: ${String(error?.stderr || error?.message || error).trim().split('\n')[0]}`);
  }
}

const BSD = new Set(['darwin', 'freebsd', 'openbsd', 'netbsd']);

/** Every file under `dir`, links included, minus .git and node_modules. */
function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Files under `target` (a folder or one file) that the immutable flag protects: flagged themselves or
 * inside a flagged folder. macOS and the BSDs keep it as chflags uchg/schg, which find reads; elsewhere
 * there is no such flag and nothing is locked. A find that cannot read some folders still reports what
 * it found; one that fails outright stops the run rather than going on as if nothing were locked.
 */
export function immutableFiles(target, platform = process.platform) {
  if (!BSD.has(platform) || !existsSync(target)) return [];
  let out;
  try {
    out = execFileSync('find', [target, '(', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune', '-o',
      '(', '-flags', '+uchg', '-o', '-flags', '+schg', ')', '-print0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error?.status === 1 && typeof error.stdout === 'string') out = error.stdout;
    else throw new Error(`cannot read the immutable flags under ${target}`);
  }
  const found = new Set();
  for (const file of out.split('\0').filter(Boolean)) {
    let stat;
    try { stat = lstatSync(file); } catch { continue; }
    if (stat.isDirectory()) for (const inner of filesUnder(file)) found.add(inner);
    else found.add(file);
  }
  return [...found].sort();
}

/** Sets or clears the user immutable flag on the link itself, never on what a link points to. */
function setLocked(file, locked) {
  try { execFileSync('chflags', ['-h', locked ? 'uchg' : 'nouchg', file], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Each listed path's kind, size and time, so a rewrite of an already-changed file still shows. */
function pathStamps(root, rels) {
  return rels.map((rel) => {
    try { const stat = lstatSync(path.join(root, rel)); return `${rel}:${stat.mode}:${stat.size}:${stat.mtimeMs}`; } catch { return `${rel}:gone`; }
  }).join('\n');
}

/** What a repository's refs and working tree look like, minus the dream's own branches. */
function repoFingerprint(top) {
  const refs = (git(top, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { allowFail: true }) ?? '')
    .split('\n').filter((line) => line && !line.startsWith(`refs/heads/${DOCS_BRANCH_PREFIX}`)).join('\n');
  const head = `${git(top, ['rev-parse', 'HEAD'], { allowFail: true }) ?? ''}|${git(top, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }) ?? ''}`;
  const status = git(top, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { allowFail: true }) ?? '';
  const changed = status.split('\0').filter(Boolean).map((entry) => entry.slice(3));
  return { refs: hash(refs + head), tree: hash(`${status}\n${pathStamps(top, changed)}`) };
}

/** What a folder outside git looks like: its files' sizes and modification times. */
function folderFingerprint(target) {
  let stat;
  try { stat = lstatSync(target); } catch { return { refs: '', tree: '' }; }
  if (!stat.isDirectory()) return { refs: '', tree: hash(`${stat.size}:${stat.mtimeMs}`) };
  const files = filesUnder(target).sort().slice(0, FINGERPRINT_FILE_LIMIT);
  return { refs: '', tree: hash(pathStamps(target, files.map((file) => path.relative(target, file)))) };
}

/**
 * The roots as tonight's run sees them: each with its resolved place, and either `ready` or `skipped`
 * with the reason. A branch root carries its repository's top and its place inside it (`scope`);
 * an edit root its place inside the home.
 */
export function resolveDocsRoots(roots, env = process.env) {
  const home = real(segnoPaths(env).home) ?? segnoPaths(env).home;
  return (Array.isArray(roots) ? roots : []).map((root) => {
    const named = { path: root?.path, mode: root?.mode };
    const problem = docsRootProblem(root, env);
    if (problem) return { ...named, status: 'skipped', reason: problem };
    const full = real(docsRootPath(root.path, env));
    if (!full) return { ...named, status: 'skipped', reason: 'the path does not exist' };
    const isFile = statSync(full).isFile();
    if (root.mode === 'edit') {
      const scope = posix(path.relative(home, full));
      if (scope.startsWith('..') || path.isAbsolute(scope)) return { ...named, status: 'skipped', reason: "it resolves outside the companion's home" };
      return { ...named, status: 'ready', resolved: full, scope };
    }
    if (root.mode === 'report') {
      const top = git(isFile ? path.dirname(full) : full, ['rev-parse', '--show-toplevel'], { allowFail: true })?.trim();
      return { ...named, status: 'ready', resolved: full, ...(top ? { repo: real(top) ?? top } : {}) };
    }
    const top = git(isFile ? path.dirname(full) : full, ['rev-parse', '--show-toplevel'], { allowFail: true })?.trim();
    if (!top) return { ...named, status: 'skipped', reason: 'not inside a git repository (a report root can still read it)' };
    const repo = real(top) ?? top;
    const rel = posix(path.relative(home, repo));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { ...named, status: 'skipped', reason: "it resolves inside the companion's home" };
    if (!git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })) return { ...named, status: 'skipped', reason: 'the repository has no commit yet' };
    return { ...named, status: 'ready', resolved: full, repo, scope: posix(path.relative(repo, full)) };
  });
}

/** A branch name no ref has yet: dream/docs-YYYYMMDD, then -2, -3… */
function freeBranch(repo, date) {
  const base = `${DOCS_BRANCH_PREFIX}${date.replaceAll('-', '')}`;
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }) === undefined) return name;
  }
}

/**
 * One repository's detached worktree at its current commit, with its locked files locked there too.
 * The repository's own state is read first, so the run's own worktree is not part of what it saw.
 */
function openWorktree(repo, scopes, runDir) {
  const before = repoFingerprint(repo);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  const locked = [...new Set(scopes.flatMap((scope) => immutableFiles(path.join(repo, scope))))]
    .map((file) => posix(path.relative(repo, file))).filter((rel) => !rel.startsWith('..')).sort();
  const worktree = path.join(runDir, 'worktrees', `${path.basename(repo)}-${hash(repo).slice(0, 8)}`);
  mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  git(repo, ['worktree', 'add', '--detach', '--quiet', worktree, base]);
  const open = { repo, base, worktree, scopes, locked, lockedHere: [], before, closed: false,
    admin: git(worktree, ['rev-parse', '--absolute-git-dir']).trim() };
  open.lockedHere = locked.filter((rel) => existsSync(path.join(worktree, rel)) && setLocked(path.join(worktree, rel), true));
  return open;
}

/**
 * Lifts the locks in a worktree and removes it. When git cannot remove it, the folder and this
 * worktree's own record in the repository go by hand; no other worktree's record is touched.
 */
function closeWorktree(open) {
  if (open.closed) return;
  for (const rel of open.lockedHere) setLocked(path.join(open.worktree, rel), false);
  open.lockedHere = [];
  if (git(open.repo, ['worktree', 'remove', '--force', '--force', open.worktree], { allowFail: true }) === undefined) {
    if (BSD.has(process.platform)) try { execFileSync('chflags', ['-R', '-h', 'nouchg', open.worktree], { stdio: 'ignore' }); } catch {}
    rmSync(open.worktree, { recursive: true, force: true });
    const common = git(open.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true })?.trim();
    if (common && path.dirname(open.admin) === path.join(common, 'worktrees')) rmSync(open.admin, { recursive: true, force: true });
  }
  open.closed = true;
}

/**
 * What the child changed under the roots, judged from the worktree's files against the base commit,
 * whatever the child did to the worktree's index or HEAD: `{ path, mode, oid }` per changed path
 * (`oid` null when it is gone). Changes outside the roots are named for the report only.
 */
function worktreeChanges(open) {
  const { worktree, base, scopes } = open;
  const baseEntries = new Map();
  for (const line of git(worktree, ['ls-tree', '-r', '-z', base, '--', ...scopes.map((scope) => scope || '.')]).split('\0').filter(Boolean)) {
    const [meta, rel] = line.split('\t');
    const [mode, , oid] = meta.split(' ');
    baseEntries.set(rel, { mode, oid });
  }
  const listed = git(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes.map((scope) => scope || '.')])
    .split('\0').filter(Boolean);
  const candidates = [...new Set([...baseEntries.keys(), ...listed])].filter((rel) => inScope(rel, scopes)).sort();
  const present = [];
  const changes = [];
  const refused = [];
  for (const rel of candidates) {
    let stat;
    try { stat = lstatSync(path.join(worktree, rel)); } catch { stat = undefined; }
    if (!stat) { if (baseEntries.has(rel)) changes.push({ path: rel, mode: '0', oid: null }); continue; }
    if (stat.isSymbolicLink()) {
      // A link the child made or moved could carry a write anywhere; links are left as the base had them.
      const was = baseEntries.get(rel);
      if (!was || was.mode !== '120000' || git(worktree, ['hash-object', '--stdin'], { input: readlinkSync(path.join(worktree, rel)) }).trim() !== was.oid)
        refused.push({ path: rel, reason: 'link' });
      continue;
    }
    if (!stat.isFile() || rel.includes('\n')) continue;
    present.push({ rel, mode: stat.mode & 0o111 ? '100755' : '100644' });
  }
  const oids = present.length ? git(worktree, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: present.map((item) => item.rel).join('\n') + '\n' })
    .trim().split('\n') : [];
  present.forEach((item, index) => {
    const was = baseEntries.get(item.rel);
    if (!was || was.oid !== oids[index] || was.mode !== item.mode) changes.push({ path: item.rel, mode: item.mode, oid: oids[index] });
  });
  // Against the base too, so a change the child committed itself is still named.
  const outside = [...(git(worktree, ['diff', '--name-only', '-z', '--no-renames', base], { allowFail: true }) ?? '').split('\0'),
    ...(git(worktree, ['ls-files', '-z', '--others', '--exclude-standard'], { allowFail: true }) ?? '').split('\0')]
    .filter((rel) => rel && !inScope(rel, scopes));
  return { changes, refused, outside };
}

/**
 * After the child: Rubato builds the commit itself, from the base commit plus the changes under the
 * roots that touch no locked file, in an index of its own, and names it as a new branch; nothing of
 * the worktree's index, HEAD or any existing branch is used or moved, and no hook runs. Then the
 * worktree goes. Returns what happened.
 */
function finishWorktree(open, { date, message, runDir }) {
  for (const rel of open.lockedHere) setLocked(path.join(open.worktree, rel), false);
  open.lockedHere = [];
  const lockedSet = new Set(open.locked);
  const { changes, refused, outside } = worktreeChanges(open);
  const kept = changes.filter((change) => !lockedSet.has(change.path));
  const reverted = [...changes.filter((change) => lockedSet.has(change.path)).map((change) => ({ path: change.path, reason: 'locked' })),
    ...refused, ...[...new Set(outside)].map((rel) => ({ path: rel, reason: 'outside the roots' }))];
  let branch = null;
  let commit = null;
  if (kept.length) {
    const index = { GIT_INDEX_FILE: path.join(runDir, `index-${hash(open.repo).slice(0, 8)}`) };
    git(open.worktree, ['read-tree', open.base], { env: index });
    git(open.worktree, ['update-index', '-z', '--index-info'], { env: index,
      input: kept.map((change) => `${change.mode} ${change.oid ?? '0'.repeat(open.base.length)}\t${change.path}\0`).join('') });
    const tree = git(open.worktree, ['write-tree'], { env: index }).trim();
    const named = git(open.worktree, ['config', 'user.email'], { allowFail: true })?.trim() ? {}
      : { GIT_AUTHOR_NAME: 'Rubato dream', GIT_AUTHOR_EMAIL: 'dream@rubato.local', GIT_COMMITTER_NAME: 'Rubato dream', GIT_COMMITTER_EMAIL: 'dream@rubato.local' };
    const sha = git(open.worktree, ['commit-tree', tree, '-p', open.base, '-m', message], { env: named }).trim();
    branch = freeBranch(open.repo, date);
    // An empty old value: the ref is created only if no branch of that name appeared meanwhile.
    git(open.repo, ['update-ref', `refs/heads/${branch}`, sha, '']);
    commit = sha.slice(0, 9);
  }
  closeWorktree(open);
  const after = repoFingerprint(open.repo);
  const sourceChanged = after.refs !== open.before.refs || after.tree !== open.before.tree;
  return { repo: open.repo, base: open.base.slice(0, 12), branch, commit, files: kept.map((change) => change.path), reverted, locked: open.locked, sourceChanged };
}

/** The report's part Rubato writes from what it checked, under the companion's own report. */
function factsSection({ repos, home, reports, skipped, failed }) {
  const lines = ['## 루바토가 확인한 것'];
  for (const item of repos) {
    lines.push(item.branch
      ? `- 브랜치 \`${item.branch}\` (${item.repo}, 커밋 ${item.commit}, 파일 ${item.files.length}개: ${item.files.slice(0, 8).join(', ')}${item.files.length > 8 ? ' …' : ''}). 원래 브랜치는 그대로고 푸시 안 함. 검토 후 머지.`
      : `- ${item.repo}: 바뀐 것 없음, 브랜치 안 만듦.`);
    for (const entry of item.reverted) lines.push(`  - 되돌림: ${entry.path} (${entry.reason === 'locked' ? '잠긴 파일' : '정리 대상 밖'})`);
    if (item.locked.length) lines.push(`  - 잠긴 파일이라 안 건드림: ${item.locked.join(', ')}`);
    if (item.sourceChanged) lines.push(`  - 확인 필요: 꿈이 도는 사이 ${item.repo} 원본 체크아웃(브랜치나 작업 트리)이 바뀜. 꿈이 건드린 건지 사용자가 작업한 건지 봐야 함.`);
  }
  if (home) {
    lines.push(home.applied.length ? `- 집: ${home.applied.join(', ')}${home.commit ? ` (커밋 ${home.commit})` : ''}` : '- 집: 바뀐 것 없음');
    for (const rel of home.refused) lines.push(`  - 안 들임: ${rel} (정리 대상 밖이거나 꿈이 고칠 수 없는 자리)`);
    for (const rel of home.conflicts) lines.push(`  - 안 들임: ${rel} (그 사이 깨어 있는 내가 고쳐서 합치기 충돌)`);
    for (const item of home.guarded) lines.push(`  - 안 들임: ${item.path} (${item.reason})`);
  }
  for (const item of reports) if (item.sourceChanged) lines.push(`- 확인 필요: 읽기만 하는 ${item.resolved}가 꿈이 도는 사이 바뀜.`);
  for (const root of skipped) lines.push(`- 건너뜀: ${root.path} (${root.mode}) — ${root.reason}`);
  if (failed) lines.push(`- 실패: ${failed}`);
  return lines.join('\n');
}

/**
 * One docs run over the roots in the companion's settings. Options mirror runCompanionDream:
 * `launch` starts an engine child, `spawnChild` runs it (tests pass a fake), `models` is the ladder,
 * `reindex` refreshes the companion's search after home files changed. Returns the run record, also
 * kept at dream/runs/<runId>/run.json; `{ status: 'not-due' }` when the job is not due.
 */
export async function runDocsDream({ env = process.env, settings, launch, spawnChild = spawnLogged, models = DREAM_MODELS, now = Date.now,
  manual = false, launchModel, childEnv = (value) => value, timeoutMs = CHILD_TIMEOUT_MS, defaultsDir = companionDefaultsDir(env), reindex } = {}) {
  const at = now();
  const paths = dreamPaths(env);
  const home = segnoPaths(env).home;
  const state = readDreamState(env);
  const due = docsDue({ at, state, settings, manual });
  if (!due.due) return { status: 'not-due', reason: due.reason };
  const runDate = localDate(at);
  const reportFile = path.join(docsReportDir(env), `${runDate}.md`);
  // Everything the run writes for itself stays inside the home: a link anywhere on those paths runs nothing.
  const outward = [paths.state, paths.lock, path.join(paths.runs, 'run'), reportFile].find((target) => !landsInside(home, target));
  if (outward) return { status: 'failed', reason: `${outward} leads outside the companion's home through a link` };
  if (!takeLock(paths.lock, at)) return { status: 'busy', reason: 'another dream is running' };
  const runId = `docs-${localIso(at).replace(/[:+]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const runDir = path.join(paths.runs, runId);
  const outDir = path.join(runDir, 'out');
  const base = { runId, startedAt: localIso(at), manual };
  const opened = [];
  const workHome = path.join(runDir, 'home');
  let homeLockedHere = [];
  let record;
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const roots = resolveDocsRoots(settings.dream.docs.roots, env);
    const ready = roots.filter((root) => root.status === 'ready');
    const skipped = roots.filter((root) => root.status === 'skipped');
    if (!ready.length) {
      record = { ...base, status: 'failed', reason: 'no root could be opened', skipped };
      return record;
    }
    // The home copy is the child's working folder, as in the memory dream; locked files stay locked there.
    ensureHomeRepo(env);
    const started = snapshot(home, env);
    materialize(workHome, started);
    const editScopes = ready.filter((root) => root.mode === 'edit').map((root) => root.scope);
    const homeLocked = editScopes.flatMap((scope) => immutableFiles(path.join(home, scope))).map((file) => posix(path.relative(home, file)));
    homeLockedHere = homeLocked.filter((rel) => existsSync(path.join(workHome, rel)) && setLocked(path.join(workHome, rel), true));

    const byRepo = new Map();
    for (const root of ready.filter((item) => item.mode === 'branch')) byRepo.set(root.repo, [...(byRepo.get(root.repo) ?? []), root.scope]);
    for (const [repo, scopes] of byRepo) opened.push(openWorktree(repo, scopes, runDir));
    const reports = ready.filter((root) => root.mode === 'report')
      .map((root) => ({ ...root, before: root.repo ? repoFingerprint(root.repo) : folderFingerprint(root.resolved) }));

    const plan = {
      job: 'docs', runAt: localIso(at), runDate, manual, cadence: settings.dream.docs.cadence,
      previous: { lastAt: state.blocks?.docs?.lastAt ?? null, report: state.docsReport?.report ?? null },
      roots: [
        ...ready.filter((root) => root.mode === 'edit').map((root) => ({ path: root.path, mode: 'edit', work: path.join(workHome, root.scope),
          locked: homeLocked.filter((rel) => inScope(rel, [root.scope])).map((rel) => path.join(workHome, rel)) })),
        ...ready.filter((root) => root.mode === 'branch').map((root) => {
          const open = opened.find((item) => item.repo === root.repo);
          return { path: root.path, mode: 'branch', repo: root.repo, work: path.join(open.worktree, root.scope), base: open.base.slice(0, 12),
            locked: open.locked.filter((rel) => inScope(rel, [root.scope])).map((rel) => path.join(open.worktree, rel)) };
        }),
        ...reports.map((root) => ({ path: root.path, mode: 'report', work: root.resolved,
          locked: immutableFiles(root.resolved) })),
      ],
      skipped: skipped.map(({ path: rootPath, mode, reason }) => ({ path: rootPath, mode, reason })),
      out: { report: path.join(outDir, 'report.md'), result: path.join(outDir, 'result.json') },
    };
    writeJson(path.join(runDir, 'plan.json'), plan);
    const promptPath = path.join(runDir, 'system-prompt.md');
    writeFileSync(promptPath, composeDreamPrompt({ env, defaultsDir, instructions: INSTRUCTIONS }), { mode: 0o600 });

    const attempts = [];
    let ok = false;
    for (const [index, rung] of models.entries()) {
      const logPath = path.join(runDir, `child-${index + 1}.log`);
      const exit = await spawnChild({
        command: launch.command,
        args: childArgs(launch, { promptPath, sessionDir: path.join(runDir, 'session'), rung, launchModel }),
        cwd: workHome,
        env: workEnv(childEnv(env), { ...launch.env, SEGNO_HOME: workHome, COMPANION_HOME: workHome, DREAM_RUN_DIR: runDir, DREAM_OUT_DIR: outDir }),
        logPath, timeoutMs,
      });
      const reported = readJson(plan.out.result);
      if (exit.code === 0 && reported) { attempts.push({ model: rung.model, ok: true }); ok = true; break; }
      attempts.push({ model: rung.model, ok: false, error: lastLine(logPath, exit.code, reported) });
      rmSync(plan.out.result, { force: true });
    }
    for (const rel of homeLockedHere.splice(0)) setLocked(path.join(workHome, rel), false);
    const result = ok ? readJson(plan.out.result) ?? {} : {};
    const message = `dream(docs): ${String(result.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || `${runDate} 문서 정리`}`;

    let homeOutcome;
    if (ok && editScopes.length) {
      // Only memory/ and notes/ inside an edit root, whatever else a registered companion's memory dream
      // may write; the resident piece stays the memory dream's, and a file shared through a hard link
      // (another name for the resident piece, or a file outside the home) is never written through.
      const resident = posix(path.relative(home, memoryPiecePath(env)));
      const locked = new Set(homeLocked);
      const linked = (rel) => { try { return lstatSync(path.join(home, rel)).nlink > 1; } catch { return false; } };
      const moved = bringHome({ home, base: started, dreamed: snapshot(workHome, env), scratch: runDir,
        writable: (rel) => rel !== resident && WRITABLE(rel) && inScope(rel, editScopes),
        guard: (rel) => (locked.has(rel) ? { reason: 'locked' } : linked(rel) ? { reason: 'hard link' } : undefined) });
      const commit = moved.applied.length ? commitOwned(moved.applied, message, { env }) : undefined;
      if (moved.applied.length && reindex) try { reindex(env); } catch { /* search catches up on its next index */ }
      homeOutcome = { ...moved, commit: commit?.commit ?? null };
    }
    const repos = [];
    for (const open of opened) {
      if (ok) { repos.push(finishWorktree(open, { date: runDate, message, runDir })); continue; }
      closeWorktree(open);
      const after = repoFingerprint(open.repo);
      repos.push({ repo: open.repo, branch: null, commit: null, files: [], reverted: [], locked: open.locked,
        sourceChanged: after.refs !== open.before.refs || after.tree !== open.before.tree });
    }
    for (const item of reports) {
      const after = item.repo ? repoFingerprint(item.repo) : folderFingerprint(item.resolved);
      item.sourceChanged = after.tree !== item.before.tree || after.refs !== item.before.refs;
    }
    const failed = ok ? undefined : `모든 모델이 실패 (${attempts.map((attempt) => `${attempt.model}: ${attempt.error}`).join('; ')})`;
    const decide = Number.isInteger(result.decide) && result.decide >= 0 ? result.decide : 0;
    const report = [`# 문서 정리 (${localIso(at)})`, readText(plan.out.report) || (ok ? '(꿈이 보고를 안 남김)' : ''),
      factsSection({ repos, home: homeOutcome, reports, skipped, failed })].filter(Boolean).join('\n\n');
    mkdirSync(path.dirname(reportFile), { recursive: true, mode: 0o700 });
    appendFileSync(reportFile, `${existsSync(reportFile) ? '\n---\n\n' : ''}${report}\n`, { mode: 0o600 });
    const branches = repos.filter((item) => item.branch).map((item) => ({ repo: item.repo, branch: item.branch, commit: item.commit }));
    const sourceChanged = repos.some((item) => item.sourceChanged) || reports.some((item) => item.sourceChanged);
    const attention = sourceChanged || skipped.length > 0 || repos.some((item) => item.reverted.length)
      || Boolean(homeOutcome && (homeOutcome.refused.length || homeOutcome.conflicts.length || homeOutcome.guarded.length));
    // The watermark moves only for a run that finished; the companion hears of every finished run, and
    // of a failed one that found its sources changed.
    const latest = readDreamState(env);
    writeJson(paths.state, { ...latest,
      ...(ok ? { blocks: { ...(latest.blocks ?? {}), docs: { lastAt: localIso(at), runId } } } : {}),
      ...(ok || sourceChanged ? { docsReport: { runId, report: reportFile, branches: branches.length, decide } } : {}) });
    record = { ...base, status: !ok ? 'failed' : result.status === 'done' && !attention ? 'done' : 'partial', attempts, report: reportFile,
      branches, decide, ...(homeOutcome ? { home: { applied: homeOutcome.applied, commit: homeOutcome.commit } } : {}),
      reverted: repos.flatMap((item) => item.reverted.map((entry) => ({ repo: item.repo, ...entry }))),
      sourceChanged: [...repos.filter((item) => item.sourceChanged).map((item) => item.repo), ...reports.filter((item) => item.sourceChanged).map((item) => item.resolved)],
      skipped: skipped.map(({ path: rootPath, reason }) => ({ path: rootPath, reason })) };
    return record;
  } catch (error) {
    record = { ...base, status: 'failed', reason: String(error?.message ?? error) };
    return record;
  } finally {
    try {
      for (const open of opened) try { closeWorktree(open); } catch { /* the repository prunes it later */ }
      for (const rel of homeLockedHere) setLocked(path.join(workHome, rel), false);
      rmSync(workHome, { recursive: true, force: true });
      rmSync(path.join(runDir, 'worktrees'), { recursive: true, force: true });
      writeJson(path.join(runDir, 'run.json'), { ...record, finishedAt: localIso(now()) });
    } finally { releaseLock(paths.lock, at); }
  }
}

/**
 * The DOCS_REPORT line for the companion's next tick, when a docs run left a report it has not been
 * shown (`seen` is the last run id shown, companion state docsReportSeen); else undefined.
 */
export function docsReportLine(env = process.env, seen) {
  const docs = readDreamState(env).docsReport;
  if (typeof docs?.runId !== 'string' || docs.runId === seen || typeof docs.report !== 'string' || !existsSync(docs.report)) return undefined;
  return { runId: docs.runId, line: `DOCS_REPORT file="${docs.report}" branches=${docs.branches ?? 0} decide=${docs.decide ?? 0}` };
}
