import "dotenv/config";
import { execSync } from "node:child_process";
import https from "node:https";
import minimist from "minimist";
import path from "node:path";
import fs from "node:fs";

// ------- Argument Parsing -------
const args = minimist(process.argv.slice(2));
const TARGET_REPO = args.repo ? path.resolve(args.repo) : process.cwd();
const DAYS_BACK = args.days ? parseInt(args.days, 10) : 1;

// ------- Environment Variables -------
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Default to basename of the target repo path if REPO env not set
const REPO_NAME = process.env.REPO || path.basename(TARGET_REPO);
const MODEL_NAME = process.env.MODEL_NAME || "gpt-4.1-mini";
const PER_BRANCH_LIMIT = parseInt(process.env.PER_BRANCH_LIMIT || "200", 10);
const DIFF_CHUNK_MAX_CHARS = parseInt(
  process.env.DIFF_CHUNK_MAX_CHARS || "80000",
  10
);

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

if (!fs.existsSync(TARGET_REPO)) {
  console.error(`❌ Repository path does not exist: ${TARGET_REPO}`);
  process.exit(1);
}

console.log(`📂 Analyzing repository: ${TARGET_REPO}`);
console.log(`📅 Looking back ${DAYS_BACK} day(s)`);

// ------- Utility Functions -------
function sh(cmd: string) {
  return execSync(cmd, {
    cwd: TARGET_REPO, // Execute commands in the target repo directory
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function safeArray<T>(xs: T[] | undefined | null) {
  return Array.isArray(xs) ? xs : [];
}

// ------- Git Operations -------

// Calculate 'since' date based on DAYS_BACK
// git log --since accepts "2 days ago", "midnight", etc.
// For robust local usage, let's use "midnight" logic relative to days back if possible,
// or just specific timestamp. "midnight" is usually today 00:00.
// If DAYS_BACK=1 (default), we want today's commits (since last midnight).
// If DAYS_BACK=2, we want since yesterday midnight? Or just strict 24h?
// The original script used "midnight". Let's stick to "midnight" if days=1,
// otherwise use relative time like "${days} days ago".
const since = DAYS_BACK === 1 ? "midnight" : `${DAYS_BACK} days ago`;
const until = "now";

// Ensure we have latest refs if it's a remote repo, but careful with auto-fetch in local dev
// We'll skip auto-fetch for local tool unless explicitly requested, or just catch errors.
// Generally in local tools, user manages state. But for summarizing "daily commits" usually implies remote work.
// Let's try to fetch but don't fail if no remote.
try {
  sh(`git fetch --all --prune --tags`);
} catch {
  // ignore, might be no remote or offline
}

// Get remote branches
let remoteBranches: string[] = [];
try {
  remoteBranches = sh(
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
    remoteBranches = sh(
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
  process.exit(0);
}

type CommitMeta = {
  sha: string;
  title: string;
  author: string;
  url: string;
  branches: string[];
};

const branchToCommits = new Map<string, string[]>();
for (const rb of remoteBranches) {
  try {
    const list = sh(
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
  allShasOrdered = sh(
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
  process.exit(0);
}

const commitMetas: CommitMeta[] = commitShas.map((sha) => {
  const title = sh(`git show -s --format=%s ${sha}`);
  const author = sh(`git show -s --format=%an ${sha}`);
  // Try to guess URL if possible.
  // If remote origin exists, parsing it could give a proper URL.
  // For now we use the basic github convention or just placeholder if unknown.
  let originUrl = "";
  try {
    originUrl = sh(`git remote get-url origin`);
  } catch {}

  let url = "";
  if (originUrl.includes("github.com")) {
    // cleaning git@github.com:org/repo.git -> org/repo
    // or https://github.com/org/repo.git
    let cleanRepo = originUrl
      .replace("git@github.com:", "")
      .replace("https://github.com/", "")
      .replace(".git", "");
    url = `https://github.com/${cleanRepo}/commit/${sha}`;
  } else {
    url = `(local commit ${sha.slice(0, 7)})`;
  }

  const branches = Array.from(shaToBranches.get(sha) || []).sort();
  return { sha, title, author, url, branches };
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
  const line = sh(`git rev-list --parents -n 1 ${sha} || true`);
  const parts = line.split(" ").filter(Boolean);
  return parts[1];
}

function getDiff(sha: string) {
  const parent = getParentSha(sha);
  // safe fallback for root commit
  const base = parent || sh(`git hash-object -t tree /dev/null`);
  const excludes = FILE_EXCLUDES.join(" ");
  const diff = sh(
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

// ------- AI & Prompts -------

type ChatPayload = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
};

async function chat(prompt: string): Promise<string> {
  console.log(`   > contacting LLM...`);
  const payload: ChatPayload = {
    model: MODEL_NAME,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  };
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const url = new URL(OPENAI_BASE_URL);
    // Handle paths properly if base url has path prefix
    // Common OpenAI compatible endpoints might be /v1/chat/completions
    // But original script used specific azure-like path: /openai/deployments/...
    // START ADAPTATION: Use standard OpenAI path structure if not overridden,
    // or try to respect base url fully.
    // simpler: assume BASE_URL is just the host+prefix, and append chat/completions if missing?
    // Let's stick closer to standard usage: ${BASE_URL}/v1/chat/completions if BASE_URL is just domain,
    // Or if BASE_URL ends with /v1, use that.

    // HOWEVER, the original script used a very specific Azure path:
    // path: `/openai/deployments/${MODEL_NAME}/chat/completions?api-version=2024-12-01-preview`
    // This suggests the user might be using Azure OpenAI.
    // For general compatibility (standard OpenAI vs Azure), it's tricky without config.
    // Let's try to detect or use a more standard path if it looks like standard OpenAI.

    // For this local version, let's assume standard OpenAI interface usually: /v1/chat/completions
    // UNLESS the base url already looks like an azure endpoint or the user wants the original azure logic.
    // Given the prompt "run this project", I should probably keep the original logic IF the user is using the original repo's assumptions,
    // BUT usually "OpenAI API Key" implies standard OpenAI. The original README said "Azure OpenAI".
    // I will change this to standard /v1/chat/completions for broader compatibility, as it's the most common default.
    // If user provides an Azure endpoint, they usually need to provide the full URL or we need to handle it.

    // Let's use a simpler approach: construction complete URL from base.

    let path = "/v1/chat/completions";
    // If the base url contains 'openai.azure.com', we might need the azure format.
    // But let's start with standard.

    // Actually, looking at the user request, they just want to run it. I should probably support standard OpenAI style by default as it's "standard".
    // I'll use the standard /v1/chat/completions which works for OpenAI, DeepSeek, etc.

    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname === "/" ? path : url.pathname, // If base has path, use it? heuristic.
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    // If base URL includes /v1 already, just append /chat/completions?
    // Let's just make sure we form a valid URL.
    if (OPENAI_BASE_URL.endsWith("/v1")) {
      reqOptions.path = "/v1/chat/completions";
    } else if (!OPENAI_BASE_URL.includes("chat/completions")) {
      // If it's just https://api.openai.com, append /v1/chat/completions
      reqOptions.path = "/v1/chat/completions";
    } else {
      // If user put full path in base url? Rare.
    }

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const json = JSON.parse(data);
            const content = json?.choices?.[0]?.message?.content?.trim() || "";
            resolve(content);
          } else {
            reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function commitChunkPrompt(
  meta: CommitMeta,
  partIdx: number,
  total: number,
  patch: string
) {
  return `你是一名资深工程师与发布经理。以下是提交 ${meta.sha.slice(0, 7)}（${
    meta.title
  }）的 diff 片段（第 ${partIdx}/${total} 段），请用中文输出结构化摘要：

提交信息：
- SHA: ${meta.sha}
- 标题: ${meta.title}
- 作者: ${meta.author}
- 分支: ${meta.branches.join(", ")}
- 链接: ${meta.url}

要求输出：
1) 变更要点（面向工程师与产品）：列出此片段涉及的主要改动与意图
2) 影响范围：模块/接口/关键文件
3) 风险&回滚点
4) 测试建议
注意：仅基于当前片段，不要臆测；不要贴长代码；如果只是格式化/重命名也请明确指出。

=== DIFF PART BEGIN ===
${patch}
=== DIFF PART END ===`;
}

function commitMergePrompt(meta: CommitMeta, parts: string[]) {
  const joined = parts.map((p, i) => `【片段${i + 1}】\n${p}`).join("\n\n");
  return `下面是提交 ${meta.sha.slice(
    0,
    7
  )} 的各片段小结，请合并为**单条提交**的最终摘要（中文），输出以下小节：
- 变更概述（不超过5条要点）
- 影响范围（模块/接口/配置）
- 风险与回滚点
- 测试建议
- 面向用户的可见影响（如有）

请避免重复、合并同类项，标注“可能不完整”当某些片段缺失或被截断。

=== 片段小结集合 BEGIN ===
${joined}
=== 片段小结集合 END ===`;
}

function dailyMergePrompt(
  dateLabel: string,
  items: { meta: CommitMeta; summary: string }[],
  repoName: string
) {
  const body = items
    .map(
      (it) =>
        `[${it.meta.sha.slice(0, 7)}] ${it.meta.title} — ${
          it.meta.author
        } — ${it.meta.branches.join(", ")}
${it.summary}`
    )
    .join("\n\n---\n\n");

  return `请将以下“当日各提交摘要”整合成**当日开发变更日报（中文）**，输出结构如下：
# ${dateLabel} 开发变更日报（${repoName})
1. 今日概览（不超过5条）
2. **按分支**的关键改动清单（每条含模块/影响、是否潜在破坏性）
3. 跨分支风险与回滚策略（如同一提交在多个分支、存在 cherry-pick/divergence）
4. 建议测试与验证清单
5. 其他备注（如重构/依赖升级/仅格式化）

=== 当日提交摘要 BEGIN ===
${body}
=== 当日提交摘要 END ===`;
}

// ------- Lark / Feishu Notification (Removed) -------
// Previous implementation removed as per user request.

// ------- Local File Saving -------
async function saveReportLocally(text: string, repoName: string) {
  const reportsDir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const sanitizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "_");
  const filename = `daily-summary-${sanitizedRepoName}-${dateStr}.md`;
  const filePath = path.join(reportsDir, filename);

  fs.writeFileSync(filePath, text, "utf8");
  console.log(`\n✅ Daily report saved to: ${filePath}`);
}

// ------- Main Execution Flow -------
(async () => {
  const perCommitFinal: { meta: CommitMeta; summary: string }[] = [];

  for (const meta of commitMetas) {
    console.log(`\nProcessing commit ${meta.sha.slice(0, 7)}...`);
    const fullPatch = getDiff(meta.sha);

    if (!fullPatch || !fullPatch.trim()) {
      console.log("   (Skipping: trivial or excluded files)");
      perCommitFinal.push({
        meta,
        summary: `（无有效业务改动或改动已被过滤，例如 lockfile/构建产物/二进制，或空提交）`,
      });
      continue;
    }

    const fileParts = splitPatchByFile(fullPatch);
    const chunks = chunkBySize(fileParts, DIFF_CHUNK_MAX_CHARS);
    console.log(`   Split into ${chunks.length} chunk(s).`);

    const partSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      //   process.stdout.write(`   Processing chunk ${i + 1}/${chunks.length}... `);
      const prompt = commitChunkPrompt(meta, i + 1, chunks.length, chunks[i]);
      try {
        const sum = await chat(prompt);
        partSummaries.push(sum || `（片段${i + 1}摘要为空）`);
        // console.log("Done.");
      } catch (e: any) {
        console.error(`   ❌ Failed chunk ${i + 1}: ${String(e.message)}`);
        partSummaries.push(`（片段${i + 1}调用失败：${String(e)}）`);
      }
    }

    // Merge chunks
    let merged = "";
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

    perCommitFinal.push({ meta, summary: merged });
  }

  // Generate Daily Summary
  console.log("\nGenerating final daily report...");
  const todayLabel = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  let daily = "";
  try {
    daily = await chat(dailyMergePrompt(todayLabel, perCommitFinal, REPO_NAME));
  } catch (e: any) {
    console.error("❌ Failed to generate daily summary:", e);
    daily =
      `（当日汇总失败，以下为逐提交原始小结拼接）\n\n` +
      perCommitFinal
        .map(
          (it) =>
            `[${it.meta.sha.slice(0, 7)}] ${
              it.meta.title
            } — ${it.meta.branches.join(", ")}\n${it.summary}`
        )
        .join("\n\n---\n\n");
  }

  await saveReportLocally(daily, REPO_NAME);
})().catch((err) => {
  console.error("❌ Fatal Error:", err);
  process.exit(1);
});
