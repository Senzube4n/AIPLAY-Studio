/**
 * THE POD RUNS THIS STUDIO'S WORKER, AT THIS STUDIO'S COMMIT.
 *
 * The RunPod screen shows a command to paste into the Pod's terminal. It used
 * to be `curl | bash` of a moving branch (a contributor fork's `main` first,
 * then this repository's `main`), and the bootstrap then cloned that branch and
 * fast-forwarded it at every rerun, so whatever that branch held when somebody
 * pasted or reran the command ran as root on their Pod, with their prompts,
 * their renders and the worker token (review of 40f5859, S2).
 *
 * Now the Studio builds the command from what it is:
 *   repository  ALWAYS Senzube4n/AIPLAY-Studio (OFFICIAL_REPO), the one the
 *               owner approved (2026-09-26). It was the build's own (a
 *               clone's appVersion().repo, or install-info.json's repo), and
 *               Setup.exe and the launcher's updater write whichever build is
 *               ahead there, a contributor's fork included: the Pod then
 *               cloned that fork, and as the updater moved between the two the
 *               next run on the same Pod stopped at "has a different Git
 *               origin" (review of the port, 2026-10-08). The commit is still
 *               this Studio's own; one that is only on another repository is
 *               refused on the Pod with nothing installed, and the window says
 *               so beforehand (`note`);
 *   commit      the full hash of the code the Studio runs from (git rev-parse
 *               HEAD, or install-info.json's commit), so the script is fetched
 *               from that commit, not a branch;
 *   sha256      of the bootstrap script at that commit: the committed blob in
 *               a clone, or this install's own copy of the file (Setup.exe and
 *               the updater unpack it from GitHub's zip of that commit, LF as
 *               .gitattributes keeps every *.sh), byte for byte what
 *               raw.githubusercontent.com serves. The Pod checks it before the
 *               script runs, so a script that differs from this Studio's own
 *               copy is never run.
 * The script then fetches exactly that commit, checks it out detached,
 * refuses to start anything unless HEAD is that commit, and never moves until
 * the Studio's own commit does (worker/bootstrap-runpod.sh).
 *
 * No command where the Studio cannot name its commit or check the script: a
 * Pod is never pointed at a branch instead.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appVersion } from "../version.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BOOTSTRAP_SCRIPT = "worker/bootstrap-runpod.sh";
/** The only repository a Pod installs its worker from (the owner, 2026-09-26). */
export const OFFICIAL_REPO = "Senzube4n/AIPLAY-Studio";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The command, from checked parts only (nothing here reaches a shell unchecked). */
export function bootstrapCommand({ repo, commit, scriptSha256 }) {
  if (!REPO_RE.test(String(repo || ""))) throw new Error("not a GitHub owner/name");
  if (!COMMIT_RE.test(String(commit || ""))) throw new Error("not a full commit hash");
  if (!SHA256_RE.test(String(scriptSha256 || ""))) throw new Error("not a sha256");
  const file = "/tmp/aiplay-bootstrap.sh";
  return `curl -fsSL https://raw.githubusercontent.com/${repo}/${commit}/${BOOTSTRAP_SCRIPT} -o ${file}`
    + ` && echo "${scriptSha256}  ${file}" | sha256sum -c -`
    + ` && AIPLAY_REPOSITORY=https://github.com/${repo}.git AIPLAY_COMMIT=${commit} bash ${file}`;
}

const readInfo = (root) => {
  try { return JSON.parse(readFileSync(path.join(root, "install-info.json"), "utf8")); } catch { return null; }
};

/** Said when this build names another repository than the official one. */
const otherRepoNote = (named) => REPO_RE.test(named) && named.toLowerCase() !== OFFICIAL_REPO.toLowerCase()
  ? `This Studio was built from ${named}; the Pod installs only from ${OFFICIAL_REPO}, at this Studio's commit. `
    + `A commit that is only on ${named} is refused on the Pod, and nothing is installed.`
  : null;

/**
 * What the RunPod screen shows: { command, repo, commit, scriptSha256,
 * problem, note }. `command` is null, and `problem` says why, where this
 * Studio cannot name the commit it runs from or has no script to check
 * against. `repo` is always OFFICIAL_REPO; `note` says so where this build
 * names another one.
 */
export function studioBootstrap({ root = ROOT, version = appVersion,
  git = (args, opts = {}) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], ...opts }) } = {}) {
  const repo = OFFICIAL_REPO;
  const none = (problem, note = null) => ({ command: null, repo, commit: null, scriptSha256: null, problem, note });
  /* A clone: its own HEAD and the committed blob of the script. */
  if (existsSync(path.join(root, ".git"))) {
    const note = otherRepoNote(String(version()?.repo || ""));
    let commit = "";
    try { commit = String(git(["rev-parse", "HEAD"], { encoding: "utf8" })).trim(); } catch { commit = ""; }
    if (!COMMIT_RE.test(commit)) return none("This Studio's git checkout did not name its commit, so there is no command to pin the Pod's worker to it.", note);
    let script;
    try { script = git(["cat-file", "blob", `${commit}:${BOOTSTRAP_SCRIPT}`]); } catch { script = null; }
    if (!script?.length) return none(`Commit ${commit.slice(0, 7)} has no ${BOOTSTRAP_SCRIPT}.`, note);
    const scriptSha256 = createHash("sha256").update(script).digest("hex");
    return { command: bootstrapCommand({ repo, commit, scriptSha256 }), repo, commit, scriptSha256, problem: null, note };
  }
  /* An install with no .git (Setup.exe, or a launcher update): the repository
   * and full commit the installer or the updater recorded, and this install's
   * own copy of the script. Both or nothing. */
  const info = readInfo(root);
  const named = String(info?.repo || "");
  const commit = String(info?.commit || "");
  const note = otherRepoNote(named);
  if (!REPO_RE.test(named) || !COMMIT_RE.test(commit)) {
    return none("This Studio cannot name the commit it runs from (no git checkout, and no install-info.json with a full commit), "
      + "so there is no command to pin the Pod's worker to it. Install Studio with Setup.exe or from a clone.", note);
  }
  let script = null;
  try { script = readFileSync(path.join(root, ...BOOTSTRAP_SCRIPT.split("/"))); } catch { script = null; }
  if (!script?.length) {
    return none(`This install has no ${BOOTSTRAP_SCRIPT} to check the Pod's script against. Update Studio from the launcher, then open this window again.`, note);
  }
  const scriptSha256 = createHash("sha256").update(script).digest("hex");
  return { command: bootstrapCommand({ repo, commit, scriptSha256 }), repo, commit, scriptSha256, problem: null, note };
}

/** Automatic deployment follows this installation's explicitly selected build.
 * Keep the old manual command's official-only policy independent. */
export function automaticWorkerCommand({ repo, commit, sha256, update = false }) {
  if (!['nemesisone-dev/aiplay-studio','senzube4n/aiplay-studio'].includes(String(repo).toLowerCase()) || !COMMIT_RE.test(commit || '') || !SHA256_RE.test(sha256 || '')) throw Error('Choose an approved pinned worker build.');
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/worker/automatic-runpod.py`;
  return `curl -fsSL --retry 3 ${url} -o /tmp/aiplay-automatic.py && echo '${sha256}  /tmp/aiplay-automatic.py' | sha256sum -c - && `
    + (update ? `AIPLAY_REPOSITORY=https://github.com/${repo}.git AIPLAY_COMMIT=${commit} ` : '') + 'exec python -u /tmp/aiplay-automatic.py';
}
export function automaticBootstrap({ root = ROOT, version = appVersion,
  git = (args, opts = {}) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], ...opts }) } = {}) {
  const info = readInfo(root), repo = String(version()?.repo || info?.repo || '');
  if (!['nemesisone-dev/aiplay-studio', 'senzube4n/aiplay-studio'].includes(repo.toLowerCase()))
    return { available: false, problem: 'This build has no approved automatic worker source.' };
  const script = 'worker/automatic-runpod.py';
  try {
    const cloned = existsSync(path.join(root, '.git'));
    const commit = cloned ? String(git(['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim() : info?.commit;
    if (!COMMIT_RE.test(commit || '')) throw new Error('Missing commit');
    const bytes = cloned ? git(['cat-file', 'blob', `${commit}:${script}`]) : readFileSync(path.join(root, script));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${script}`;
    const command = automaticWorkerCommand({ repo, commit, sha256 });
    // The acceptance supervisor must exist before the first network fetch.
    // Embed this same published, pinned bootstrap rather than fetching a guard
    // after compute is already running. No credential appears in the command.
    const acceptanceProtocol = /^ACCEPTANCE_PROTOCOL = 2\r?$/m.test(Buffer.from(bytes).toString('utf8')) ? 2 : null;
    const acceptanceCommand = acceptanceProtocol ? `exec python -u -c 'import base64; exec(compile(base64.b64decode("${Buffer.from(bytes).toString('base64')}"), "aiplay-pinned-bootstrap", "exec"))'` : null;
    return { available: true, repo, commit, sha256, url, command, acceptanceCommand, acceptanceProtocol };
  } catch { return { available: false, problem: 'Update AIPLAY to a published build with automatic AI installation.' }; }
}
