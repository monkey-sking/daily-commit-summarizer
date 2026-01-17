import "dotenv/config";
import { execSync } from "node:child_process";

import minimist from "minimist";
import path from "node:path";
import OpenAI from "openai";
import fs from "node:fs";
import crypto from "node:crypto";

// ------- Argument Parsing -------
const args = minimist(process.argv.slice(2));
const TARGET_DIR = args.dir ? path.resolve(args.dir) : null;
const SINGLE_REPO = args.repo ? path.resolve(args.repo) : (TARGET_DIR ? null : process.cwd());
const DAYS_BACK = args.days ? parseInt(args.days, 10) : 1;
const SINCE_DATE = args.since || null; // e.g. "2025-04-01"
const RECURSIVE_SCAN = args.recursive || args.r || false;
const EXCLUDE_PATHS = args.exclude ? (Array.isArray(args.exclude) ? args.exclude : [args.exclude]) : [];

// Owner whitelist for filtering third-party repos (based on remote URL)
const GIT_OWNERS = (args.owners || process.env.GIT_OWNERS || "")
  .split(",")
  .map((s: string) => s.trim().toLowerCase())
  .filter(Boolean);

// Run mode: online (use AI) or offline (git log only)
const RUN_MODE: "online" | "offline" = (args.mode || process.env.RUN_MODE || "online") as "online" | "offline";

// Custom prompts file path
const PROMPTS_FILE = args.prompts || process.env.PROMPTS_FILE || null;

// Report filename format (supports: {{date}}, {{repo}})
// Default: "{{date}}_{{repo}}.md"
const REPORT_FILENAME_FORMAT = process.env.REPORT_FILENAME_FORMAT || "{{date}}_{{repo}}.md";

// ------- Environment Variables -------
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Default to basename of the target repo path if REPO env not set
// This will be set dynamically per repo in analyzeRepo
// const REPO_NAME = process.env.REPO || path.basename(TARGET_REPO);
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4.1-mini";
const PER_BRANCH_LIMIT = parseInt(process.env.PER_BRANCH_LIMIT || "200", 10);
const DIFF_CHUNK_MAX_CHARS = parseInt(
  process.env.DIFF_CHUNK_MAX_CHARS || "80000",
  10
);
const SYNC_CACHE_WITH_GIT = process.env.SYNC_CACHE_WITH_GIT === "true";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  Missing OPENAI_API_KEY in .env. AI summarization will be skipped (Offline Mode).");
}

// Initial check for single repo mode
if (!TARGET_DIR && SINGLE_REPO && !fs.existsSync(SINGLE_REPO)) {
  console.error(`❌ Repository path does not exist: ${SINGLE_REPO}`);
  process.exit(1);
}

// ------- Utility Functions -------
// The global sh function is no longer used directly for git operations within analyzeRepo
// as analyzeRepo will define its own sh variant with the correct cwd.
function sh(cmd: string) {
  return execSync(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function safeArray<T>(xs: T[] | undefined | null) {
  return Array.isArray(xs) ? xs : [];
}

// ------- Repository Discovery -------

/**
 * Recursively discover all Git repositories under a directory
 */
function discoverGitRepos(baseDir: string, recursive: boolean, excludePaths: string[] = []): string[] {
  const repos: string[] = [];
  
  function isExcluded(repoPath: string): boolean {
    return excludePaths.some(excluded => {
      const normalizedExclude = path.resolve(excluded);
      return repoPath === normalizedExclude || repoPath.startsWith(normalizedExclude + path.sep);
    });
  }
  
  function scan(dir: string, depth: number) {
    try {
      const gitDir = path.join(dir, ".git");
      if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
        if (!isExcluded(dir)) {
          repos.push(dir);
        }
        // Don't scan subdirectories of a git repo (they would be submodules)
        return;
      }
      
      // If not recursive and depth > 0, stop
      if (!recursive && depth > 0) return;
      
      // Scan subdirectories
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip common non-project directories
        if (entry.name.startsWith('.') || 
            entry.name === 'node_modules' || 
            entry.name === 'Intermediate' ||
            entry.name === 'DerivedDataCache' ||
            entry.name === 'Binaries' ||
            entry.name === 'Build') continue;
        
        scan(path.join(dir, entry.name), depth + 1);
      }
    } catch (e) {
      // Permission denied or other error, skip
    }
  }
  
  // For non-recursive mode, only scan direct subdirectories
  if (!recursive) {
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subdir = path.join(baseDir, entry.name);
        if (fs.existsSync(path.join(subdir, ".git"))) {
          if (!isExcluded(subdir)) {
            repos.push(subdir);
          }
        }
      }
    } catch (e) {
      // ignore
    }
  } else {
    scan(baseDir, 0);
  }
  
  return repos;
}

/**
 * Extract owner from a Git remote URL
 * Supports: GitHub, GitLab, Gitee, Bitbucket, etc.
 */
function extractOwnerFromUrl(remoteUrl: string): string | null {
  if (!remoteUrl) return null;
  
  // Handle SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+)\//);
  if (sshMatch) return sshMatch[1].toLowerCase();
  
  // Handle HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1].toLowerCase();
  
  return null;
}

/**
 * Check if a repository is third-party based on remote URL owner
 */
function isThirdPartyRepo(repoPath: string, ownerWhitelist: string[]): { isThirdParty: boolean; reason?: string } {
  // If no whitelist, don't filter
  if (ownerWhitelist.length === 0) {
    return { isThirdParty: false };
  }
  
  try {
    // Get remote origin URL
    const remoteUrl = execSync(
      `git remote get-url origin 2>/dev/null || true`,
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    
    // No remote = local repo, keep it
    if (!remoteUrl) {
      return { isThirdParty: false };
    }
    
    const owner = extractOwnerFromUrl(remoteUrl);
    if (!owner) {
      // Can't parse URL, keep the repo
      return { isThirdParty: false };
    }
    
    // Check if owner is in whitelist
    if (ownerWhitelist.includes(owner)) {
      return { isThirdParty: false };
    }
    
    return { 
      isThirdParty: true, 
      reason: `Owner: ${owner}` 
    };
  } catch (e) {
    return { isThirdParty: false }; // On error, don't exclude
  }
}

// ------- AI & Prompts -------

// ------- API Configuration & Client Rotation -------
const OPENAI_API_KEYS = OPENAI_API_KEY.split(",").map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

function getClient() {
  const key = OPENAI_API_KEYS[currentKeyIndex] || OPENAI_API_KEY;
  return new OpenAI({
    apiKey: key,
    baseURL: OPENAI_BASE_URL,
  });
}

/**
 * Switch to the next API key in the list
 */
function rotateApiKey() {
  if (OPENAI_API_KEYS.length > 1) {
    const oldIndex = currentKeyIndex;
    currentKeyIndex = (currentKeyIndex + 1) % OPENAI_API_KEYS.length;
    console.warn(`\n🔄 [Rotation] Rate limited or 503. Switching API Key: [${oldIndex + 1}/${OPENAI_API_KEYS.length}] -> [${currentKeyIndex + 1}/${OPENAI_API_KEYS.length}]`);
    return true;
  }
  return false;
}

async function chat(prompt: string): Promise<string> {
  const maxRetries = 10;
  let attempts = 0;

  while (attempts < maxRetries) {
      try {
          const currentClient = getClient();
          console.log(`   > LLM [${MODEL_NAME}] (Attempt ${attempts + 1}, Key ${currentKeyIndex + 1}/${OPENAI_API_KEYS.length || 1})`);
          
          const response = await currentClient.chat.completions.create({
              model: MODEL_NAME,
              messages: [{ role: "user", content: prompt }],
              temperature: 0.2,
          });
          
          return response.choices[0]?.message?.content?.trim() || "";
      } catch (e: any) {
          attempts++;
          const errMsg = e.message || "";
          const isRateLimit = errMsg.includes("limited") || errMsg.includes("wait") || errMsg.includes("429") || errMsg.includes("503");

          if (isRateLimit) {
              console.warn(`\n🔍 [Debug] LLM Error: ${errMsg}`);
              // Rotation first
              if (rotateApiKey()) {
                  console.log(`   🚀 Key rotated, retrying immediately...`);
                  continue; 
              }

              // Special logic for gemini-3-flash as requested: no wait
              if (MODEL_NAME === "gemini-3-flash") {
                  console.warn(`\n⚠️  Model ${MODEL_NAME} rate limited. Retrying in 2s (bypass wait)...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
              }

              const match = errMsg.match(/wait (\d+)s/);
              let seconds = match ? parseInt(match[1], 10) : 10;
              
              if (seconds > 30) {
                  console.warn(`\n⚠️  Rate limited. Server asked ${seconds}s, capping to 30s...`);
                  seconds = 30;
              } else {
                  console.warn(`\n⚠️  Rate limited. Waiting ${seconds}s...`);
              }

              await new Promise(r => setTimeout(r, (seconds + 1) * 1000));
              continue;
          }

          if (attempts >= maxRetries) throw e;
          
          console.error(`   ❌ Chat error: ${errMsg}. Retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
      }
  }
  throw new Error("Max retries exceeded");
}

// ------- Prompt Configuration -------

interface PromptConfig {
  commitChunk?: string;
  commitMerge?: string;
  dailyMerge?: string;
}

const DEFAULT_PROMPTS: PromptConfig = {
  commitChunk: `Please summarize this code change in **one sentence**.
No analysis or explanation needed, just concisely describe "what changed".
Example: "Fixed validation issue during user login" or "Added Excel export feature"

Commit title for reference: {{title}}

=== DIFF ===
{{patch}}
=== END ===`,
  commitMerge: `Merge the following descriptions into **one sentence** summary:
{{parts}}`,
  dailyMerge: `Please consolidate the following commit summaries into a **daily development changelog (Chinese)**:
# {{dateLabel}} Development Changelog ({{repoName}})
1. Today's overview (max 5 items)
2. Key changes by branch (module/impact, breaking changes)
3. Cross-branch risks and rollback strategy
4. Suggested testing checklist
5. Other notes (refactoring/dependency updates/formatting only)

=== Daily Commit Summaries BEGIN ===
{{body}}
=== Daily Commit Summaries END ===`
};

let customPrompts: PromptConfig = {};

// Load custom prompts from file if specified
if (PROMPTS_FILE && fs.existsSync(PROMPTS_FILE)) {
  try {
    customPrompts = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8"));
    console.log(`📝 Loaded custom prompts from: ${PROMPTS_FILE}`);
  } catch (e) {
    console.warn(`⚠️  Failed to load prompts file: ${PROMPTS_FILE}`);
  }
}

function getPrompt(key: keyof PromptConfig): string {
  return customPrompts[key] || DEFAULT_PROMPTS[key] || "";
}

function commitChunkPrompt(
  meta: CommitMeta,
  partIdx: number,
  total: number,
  patch: string
) {
  return getPrompt("commitChunk")
    .replace(/\{\{title\}\}/g, meta.title)
    .replace(/\{\{patch\}\}/g, patch)
    .replace(/\{\{partIdx\}\}/g, String(partIdx))
    .replace(/\{\{total\}\}/g, String(total));
}

function commitMergePrompt(meta: CommitMeta, parts: string[]) {
  const joined = parts.join("\n");
  return getPrompt("commitMerge")
    .replace(/\{\{parts\}\}/g, joined);
}

function dailyMergePrompt(
  dateLabel: string,
  items: { meta: CommitMeta; summary: string }[],
  repoName: string
) {
  const body = items
    .map(
      (it) =>
        `[${it.meta.sha.slice(0, 7)}] ${it.meta.title} -- ${
          it.meta.author
        } -- ${it.meta.branches.join(", ")}
${it.summary}`
    )
    .join("\n\n---\n\n");

  return getPrompt("dailyMerge")
    .replace(/\{\{dateLabel\}\}/g, dateLabel)
    .replace(/\{\{repoName\}\}/g, repoName)
    .replace(/\{\{body\}\}/g, body);
}

// ------- Lark / Feishu Notification (Removed) -------
type CommitMeta = {
  sha: string;
  date: string; // YYYY-MM-DD
  title: string;
  author: string;
  url: string;
  branches: string[];
  stat?: string;
};

// ... (previous code) ...

// ------- Core Logic: Analyze Single Repo -------
// Returns list of processed commits with their summaries
async function analyzeRepo(repoPath: string): Promise<{ repoName: string; repoOwner: string; results: { meta: CommitMeta; summary: string }[] } | null> {
  const repoName = path.basename(repoPath);

  // ------- Caching Logic -------
  const CACHE_DIR = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  
  // Create a readable cache filename
  const dateRange = SINCE_DATE ? `since-${SINCE_DATE}` : `days-${DAYS_BACK}`;
  const sanitizedRepoName = repoName.replace(/[\/?:*"<>|]/g, "_");
  const cacheFile = path.join(CACHE_DIR, `${sanitizedRepoName}_${dateRange}.json`);

  // Try loading from cache (partial or complete)
  let cachedResults: { meta: CommitMeta; summary: string }[] = [];
  let cachedShas = new Set<string>();
  
  if (fs.existsSync(cacheFile)) {
      try {
          const cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          if (cachedData && cachedData.repoName === repoName && Array.isArray(cachedData.results)) {
              // Only load results that don't look like errors
              cachedResults = cachedData.results.filter((r: { summary: string }) => 
                !r.summary.includes("Failed") && 
                !r.summary.includes("limited") && 
                !r.summary.includes("503") &&
                !r.summary.includes("摘要为空")
              );
              cachedShas = new Set(cachedResults.map(r => r.meta.sha));
              console.log(`\n🔄 [Cache] Found ${cachedResults.length} valid cached commits for: ${repoName}`);
          }
      } catch (e) {
          console.warn(`   (Cache file corrupted, ignoring: ${cacheFile})`);
      }
  }

  console.log(`\n📂 Analyzing repository: ${repoPath}`);
  if (SINCE_DATE) {
    console.log(`📅 Looking back since ${SINCE_DATE}`);
  } else {
    console.log(`📅 Looking back ${DAYS_BACK} day(s)`);
  }

  // Local sh helper for this repo
  const runGit = (cmd: string) => execSync(cmd, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 }).trim();

  // 1. Check if it's a git repo
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    console.log(`   (Skipping: not a git repository)`);
    return null;
  }

  // Get repo owner from remote url
  let repoOwner = "";
  try {
    const remoteUrl = execSync("git remote get-url origin || true", { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (remoteUrl) repoOwner = extractOwnerFromUrl(remoteUrl) || "";
  } catch (e) {}

  // ------- Git Operations -------

  // Calculate 'since' date based on DAYS_BACK
  const since = SINCE_DATE ? SINCE_DATE : (DAYS_BACK === 1 ? "midnight" : `${DAYS_BACK} days ago`);
  const until = "now";

  try {
    runGit(`git fetch --all --prune --tags`);
  } catch {
    // ignore, might be no remote or offline
  }

  // Get remote branches
  let remoteBranches: string[] = [];
  try {
    remoteBranches = runGit(
      `git for-each-ref --format="%(refname:short)" refs/remotes/origin | grep -v "^origin/HEAD$" || true`
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    // ignore
  }

  if (remoteBranches.length === 0) {
    console.warn("⚠️ No remote branches found. Checking local branches instead.");
    try {
      remoteBranches = runGit(
        `git for-each-ref --format="%(refname:short)" refs/heads`
      )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (e) {
      console.error("Error listing local branches:", e);
    }
  }

  if (remoteBranches.length === 0) {
    console.warn("⚠️ No branches found to analyze.");
    return null;
  }

  const branchToCommits = new Map<string, string[]>();
  for (const rb of remoteBranches) {
    try {
      const list = runGit(
        `git log ${rb} --no-merges --since="${since}" --until="${until}" --pretty=format:%H --reverse || true`
      )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > 0) {
        branchToCommits.set(rb, list.slice(-PER_BRANCH_LIMIT));
      }
    } catch (e) {
      // ignore branch errors
    }
  }

  const shaToBranches = new Map<string, Set<string>>();
  for (const [rb, shas] of branchToCommits) {
    for (const sha of shas) {
      if (!shaToBranches.has(sha)) shaToBranches.set(sha, new Set());
      shaToBranches.get(sha)!.add(rb);
    }
  }

  // Global view of commits roughly in order
  let allShasOrdered: string[] = [];
  try {
    allShasOrdered = runGit(
      `git log --no-merges --since="${since}" --until="${until}" --all --pretty=format:%H --reverse || true`
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    // fallback
  }

  const seen = new Set<string>();
  const commitShas = allShasOrdered.filter((sha) => {
    if (seen.has(sha)) return false;
    if (!shaToBranches.has(sha)) return false;
    seen.add(sha);
    return true;
  });

  if (commitShas.length === 0) {
    console.log("📭 No valid commits found since " + since);
    return null;
  }

  // ------- Cache Sync (Pruning) -------
  if (SYNC_CACHE_WITH_GIT && cachedResults.length > 0) {
      const currentShasSet = new Set(commitShas);
      const originalCount = cachedResults.length;
      cachedResults = cachedResults.filter(r => currentShasSet.has(r.meta.sha));
      
      if (cachedResults.length < originalCount) {
          console.log(`🧹 [Sync] Pruned ${originalCount - cachedResults.length} stale commits from cache.`);
          cachedShas = new Set(cachedResults.map(r => r.meta.sha));
          // Update cache file immediately
          try {
              fs.writeFileSync(cacheFile, JSON.stringify({ repoName, results: cachedResults }, null, 2), "utf8");
          } catch (e) {
              console.warn(`   ⚠️  Failed to save pruned cache: ${e}`);
          }
      }
  }

  const commitMetas: CommitMeta[] = commitShas.map((sha) => {
    const title = runGit(`git show -s --format=%s ${sha}`);
    const author = runGit(`git show -s --format=%an ${sha}`);
    const date = runGit(`git show -s --format=%cd --date=format:%Y-%m-%d ${sha}`);
    // Get stats
    let stat = "";
    try {
        // git show --stat --format="" returns just the stat lines
        // For root commit, sometimes it needs --root
        stat = runGit(`git show --stat --root --format="" ${sha}`).trim();
    } catch (e: any) {
        // failed to get stats
    }
    
    // Fallback if empty (e.g. merge commit without conflict resolution might look empty in stat?)
    if (!stat) stat = "(No file changes detected in stat)";

    let originUrl = "";
    try {
      originUrl = runGit(`git remote get-url origin`);
    } catch {}

    let url = "";
    if (originUrl.includes("github.com")) {
      let cleanRepo = originUrl
        .replace("git@github.com:", "")
        .replace("https://github.com/", "")
        .replace(".git", "");
      url = `https://github.com/${cleanRepo}/commit/${sha}`;
    } else {
      url = `(local commit ${sha.slice(0, 7)})`;
    }

    const branches = Array.from(shaToBranches.get(sha) || []).sort();
    return { sha, date, title, author, url, branches, stat };
  });

  console.log(`📝 Found ${commitMetas.length} commits to summarize...`);

  // ------- Diff Handling -------
  const FILE_EXCLUDES = [
    ":!**/*.lock",
    ":!**/dist/**",
    ":!**/build/**",
    ":!**/.next/**",
    ":!**/.vite/**",
    ":!**/out/**",
    ":!**/coverage/**",
    ":!package-lock.json",
    ":!pnpm-lock.yaml",
    ":!yarn.lock",
    ":!**/*.min.*",
    ":!**/node_modules/**",
  ];

  function getParentSha(sha: string) {
    const line = runGit(`git rev-list --parents -n 1 ${sha} || true`);
    const parts = line.split(" ").filter(Boolean);
    return parts[1];
  }

  function getDiff(sha: string) {
    const parent = getParentSha(sha);
    const base = parent || runGit(`git hash-object -t tree /dev/null`);
    const excludes = FILE_EXCLUDES.join(" ");
    const diff = runGit(
      `git diff --unified=0 --minimal ${base} ${sha} -- . ${excludes} || true`
    );
    return diff;
  }

  function splitPatchByFile(patch: string): string[] {
    if (!patch) return [];
    const parts = patch.split(/^diff --git.*$/m);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function chunkBySize(parts: string[], limit = DIFF_CHUNK_MAX_CHARS): string[] {
    const out: string[] = [];
    let buf = "";
    for (const p of parts) {
      const candidate = buf ? `${buf}\n\n${p}` : p;
      if (candidate.length > limit) {
        if (buf) out.push(buf);
        if (p.length > limit) {
          for (let i = 0; i < p.length; i += limit) {
            out.push(p.slice(i, i + limit));
          }
          buf = "";
        } else {
          buf = p;
        }
      } else {
        buf = candidate;
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  // Helper to generate offline report
  function generateOfflineReport(repoName: string, dateLabel: string, items: CommitMeta[]) {
      const rows = items.map(c => {
          const shaShort = c.sha.slice(0, 7);
          const statCompact = c.stat ? c.stat.split('\n').pop()?.trim() || "N/A" : "N/A";
          return `| [${shaShort}](${c.url}) | **${c.title}** | ${c.author} | ${statCompact} |`;
      }).join("\n");

      return `# ${dateLabel} 开发变更日报 (Log Based) - ${repoName}

> ⚠️ **注意**：由于无法连接 AI 服务，以下内容基于原始 Git 日志生成。

## 📊 今日概览
- **提交总数**: ${items.length}
- **涉及分支**: ${Array.from(new Set(items.flatMap(i => i.branches))).join(", ")}

## 📝 提交清单

| SHA | 标题 | 作者 | 变更统计 |
|-----|------|------|----------|
${rows}

## 🔍 详细变更
${items.map(c => `
### ${c.title}
- **SHA**: \`${c.sha.slice(0, 7)}\`
- **Branch**: ${c.branches.join(", ")}
- **Author**: ${c.author}
- **Stats**:
\`\`\`text
${c.stat}
\`\`\`
`).join("\n---\n")}
`;
  }

  // Create a map for fast lookup of existing summaries
  const cachedSummaryMap = new Map<string, string>();
  cachedResults.forEach(r => cachedSummaryMap.set(r.meta.sha, r.summary));

  // We will rebuild the final list strictly based on Git history order (commitMetas)
  const perCommitFinal: { meta: CommitMeta; summary: string }[] = [];

  // Identify "orphaned" commits (in cache but not in current Git history)
  // If SYNC_CACHE_WITH_GIT is TRUE, 'cachedResults' was already pruned earlier, so orphans is empty.
  // If SYNC_CACHE_WITH_GIT is FALSE, 'cachedResults' contains everything, so we filter out current ones to find orphans.
  const currentShasSet = new Set(commitMetas.map(m => m.sha));
  const orphanedCommits = cachedResults.filter(r => !currentShasSet.has(r.meta.sha));

  for (let i = 0; i < commitMetas.length; i++) {
    const meta = commitMetas[i];

    // If we have a valid summary in cache, use it directly
    if (cachedSummaryMap.has(meta.sha)) {
       perCommitFinal.push({ meta, summary: cachedSummaryMap.get(meta.sha)! });
       continue;
    }
    
    console.log(`\nProcessing commit ${meta.sha.slice(0, 7)}... (${i + 1}/${commitMetas.length})`);
    const fullPatch = getDiff(meta.sha);

    if (!fullPatch || !fullPatch.trim()) {
      console.log("   (Skipping: trivial or excluded files)");
      const summary = `（无有效业务改动或改动已被过滤，例如 lockfile/构建产物/二进制，或空提交）`;
      perCommitFinal.push({ meta, summary });
      
      // Save trivial commit to cache immediately
      try {
          const partialResult = { repoName, results: [...perCommitFinal] };
          fs.writeFileSync(cacheFile, JSON.stringify(partialResult, null, 2), "utf8");
      } catch (e) { /* ignore */ }
      
      continue;
    }

    const fileParts = splitPatchByFile(fullPatch);
    const chunks = chunkBySize(fileParts, DIFF_CHUNK_MAX_CHARS);
    console.log(`   Split into ${chunks.length} chunk(s).`);

    let merged = "";
    
    // Offline mode: skip AI, use commit title as summary
    if (RUN_MODE === "offline" || !OPENAI_API_KEY) {
      console.log(`   📋 Offline mode: using commit title as summary`);
      merged = meta.title;
    } else {
      // Online mode: use AI
      const partSummaries: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const prompt = commitChunkPrompt(meta, i + 1, chunks.length, chunks[i]);
        try {
          const sum = await chat(prompt);
          partSummaries.push(sum || `（片段${i + 1}摘要为空）`);
        } catch (e: any) {
          console.error(`   ❌ Failed chunk ${i + 1}: ${String(e.message)}`);
          partSummaries.push(`（片段${i + 1}调用失败：${String(e)}）`);
        }
      }

      // Merge chunks
      if (chunks.length > 1) {
        console.log("   Merging chunks...");
        try {
          merged = await chat(commitMergePrompt(meta, partSummaries));
        } catch (e: any) {
          merged = partSummaries.join("\n\n");
        }
      } else {
        merged = partSummaries[0] || "";
      }
    }

    perCommitFinal.push({ meta, summary: merged });
    
    // Incremental save to cache after each commit
    try {
        // Save: Valid Current Commits + Orphans (if any)
        const combinedResults = [...perCommitFinal, ...orphanedCommits];
        const partialResult = { repoName, results: combinedResults };
        fs.writeFileSync(cacheFile, JSON.stringify(partialResult, null, 2), "utf8");
    } catch (e) {
        // Ignore save errors, continue processing
    }
    
    // Also write to markdown file immediately
    const reportsDir = path.join(process.cwd(), "reports");
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const sanitizedProjName = repoName.replace(/[\/?:*"<>|]/g, "_");
    const [year, month] = meta.date.split("-");
    const mdFilename = REPORT_FILENAME_FORMAT
      .replace(/\{\{date\}\}/g, meta.date)
      .replace(/\{\{year\}\}/g, year)
      .replace(/\{\{month\}\}/g, month)
      .replace(/\{\{repo\}\}/g, sanitizedProjName)
      .replace(/\{\{owner\}\}/g, repoOwner || "unknown")
      .replace(/\{\{author\}\}/g, meta.author.replace(/\s+/g, "_"));
      
    const mdPath = path.join(reportsDir, mdFilename);
    
    // Create header if file doesn't exist
    if (!fs.existsSync(mdPath)) {
        fs.writeFileSync(mdPath, `# 📅 ${meta.date} - ${repoName}\n\n`, "utf8");
    }
    
    // Append this commit
    const statShort = meta.stat ? meta.stat.split('\n').pop()?.trim() : "";
    let entry = `## ${meta.title} (${meta.sha.slice(0,7)})\n`;
    entry += `👤 ${meta.author}`;
    if (statShort) entry += ` | 📊 \`${statShort}\``;
    entry += `\n\n${merged}\n\n---\n\n`;
    
    fs.appendFileSync(mdPath, entry, "utf8");
    console.log(`   📝 Appended to: ${mdFilename}`);
  }

  // Generate Daily Summary
  // We no longer generate a per-repo report here. 
  // We return the processed commits to the main loop for consolidation.
  
  const finalResult = { repoName, repoOwner, results: perCommitFinal };
  
  // Save to cache
  try {
      fs.writeFileSync(cacheFile, JSON.stringify(finalResult, null, 2), "utf8");
      console.log(`💾 Progress saved to cache: ${cacheFile}`);
  } catch (e) {
      console.error("❌ Failed to save cache:", e);
  }

  return finalResult;
}

// ------- Consolidation & Reporting -------

async function consolidateAndSave(allData: { repoName: string; repoOwner: string; results: { meta: CommitMeta; summary: string }[] }[]) {
  if (allData.length === 0) return;

  // 1. Group by Date
  const byDate = new Map<string, { repoName: string; repoOwner: string; items: { meta: CommitMeta; summary: string }[] }[]>();
  
  for (const repoData of allData) {
      for (const item of repoData.results) {
          const date = item.meta.date;
          if (!byDate.has(date)) byDate.set(date, []);
          
          let dateGroup = byDate.get(date)!;
          let repoGroup = dateGroup.find(g => g.repoName === repoData.repoName);
          if (!repoGroup) {
              repoGroup = { repoName: repoData.repoName, repoOwner: repoData.repoOwner, items: [] };
              dateGroup.push(repoGroup);
          }
          repoGroup.items.push(item);
      }
  }

  // 2. Sort Dates Descending
  const sortedDates = Array.from(byDate.keys()).sort().reverse();
  
  // 3. Ensure reports directory exists
  const reportsDir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  // 4. Generate one file per (Date, Project)
  for (const date of sortedDates) {
      const projects = byDate.get(date)!;
      
      for (const proj of projects) {
          let markdown = `# 📅 ${date} - 📂 ${proj.repoName}\n\n`;
          
          // Content for this project on this day
          for (const item of proj.items) {
             const statShort = item.meta.stat ? item.meta.stat.split('\n').pop()?.trim() : "";
             
             // Commit Title as H2
             markdown += `## 📝 ${item.meta.title} ([${item.meta.sha.slice(0,7)}](${item.meta.url})) ${item.meta.author}\n`;
             if (statShort) markdown += `> 📊 \`${statShort}\`\n\n`;
             
             // Summary content
             let sum = item.summary.replace(/^### /gm, "### "); // Keep H3
             markdown += `${sum}\n\n---\n\n`;
          }
          
          // Sanitize project name for filename
          const sanitizedProjName = proj.repoName.replace(/[\/?:*"<>|]/g, "_");
          const [year, month] = date.split("-");
          // Use first author from items as representative if needed
          const mainAuthor = proj.items[0]?.meta.author.replace(/\s+/g, "_") || "unknown";
          
          const filename = REPORT_FILENAME_FORMAT
            .replace(/\{\{date\}\}/g, date)
            .replace(/\{\{year\}\}/g, year)
            .replace(/\{\{month\}\}/g, month)
            .replace(/\{\{repo\}\}/g, sanitizedProjName)
            .replace(/\{\{owner\}\}/g, proj.repoOwner || "unknown")
            .replace(/\{\{author\}\}/g, mainAuthor);
            
          const filePath = path.join(reportsDir, filename);
          
          fs.writeFileSync(filePath, markdown, "utf8");
          console.log(`  ✅ Saved: ${filePath}`);
      }
  }
  
  console.log(`\n✅ All reports saved to: ${reportsDir}/`);
}

// ------- Main Execution Flow -------
(async () => {
  const accumulatedResults: { repoName: string; repoOwner: string; results: { meta: CommitMeta; summary: string }[] }[] = [];

  if (TARGET_DIR) {
    console.log(`\n🔍 Scanning directory: ${TARGET_DIR}`);
    console.log(`   Recursive: ${RECURSIVE_SCAN ? 'Yes' : 'No'}`);
    console.log(`   Mode: ${RUN_MODE}`);
    if (GIT_OWNERS.length > 0) {
      console.log(`   Owner whitelist: ${GIT_OWNERS.join(", ")} (third-party repos will be skipped)`);
    }
    if (EXCLUDE_PATHS.length > 0) {
      console.log(`   Excluded paths: ${EXCLUDE_PATHS.join(", ")}`);
    }
    
    // Use the new discovery function
    const discoveredRepos = discoverGitRepos(TARGET_DIR, RECURSIVE_SCAN, EXCLUDE_PATHS);
    console.log(`\n📂 Found ${discoveredRepos.length} Git repositories\n`);
    
    // Filter out third-party repos
    const reposToAnalyze: string[] = [];
    for (const repoPath of discoveredRepos) {
      const { isThirdParty, reason } = isThirdPartyRepo(repoPath, GIT_OWNERS);
      const repoName = path.basename(repoPath);
      if (isThirdParty) {
        console.log(`   ⏭️  Skipping third-party: ${repoName} (${reason})`);
      } else {
        reposToAnalyze.push(repoPath);
      }
    }
    
    console.log(`\n✅ ${reposToAnalyze.length} repositories to analyze\n`);

    const totalRepos = reposToAnalyze.length;
    let repoIndex = 0;

    for (const dir of reposToAnalyze) {
      repoIndex++;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📊 Repository Progress: [${repoIndex}/${totalRepos}]`);
      try {
        const result = await analyzeRepo(dir);
        if (result && result.results.length > 0) {
          accumulatedResults.push(result);
        }
      } catch (err) {
        console.error(`❌ Error analyzing ${dir}:`, err);
      }
    }
  } else if (SINGLE_REPO) {
    try {
      const result = await analyzeRepo(SINGLE_REPO);
       if (result && result.results.length > 0) {
          accumulatedResults.push(result);
        }
    } catch (err) {
      console.error("❌ Fatal Error:", err);
      process.exit(1);
    }
  } else {
    console.error("❌ No target repository or directory specified. Use --repo <path> or --dir <path>.");
    process.exit(1);
  }

  // Generate consolidated report
  if (accumulatedResults.length > 0) {
      await consolidateAndSave(accumulatedResults);
  } else {
      console.log("No commits found to consolidate.");
  }

})().catch((err) => {
  console.error("❌ Fatal Error in main execution:", err);
  process.exit(1);
});
