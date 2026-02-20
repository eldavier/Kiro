/**
 * Delete Spam Comments Script
 * Scans issue and PR comments for spam content and deletes them.
 * Triggered on new comments or run on a schedule for bulk cleanup.
 */

import { Octokit } from "@octokit/rest";
import { retryWithBackoff } from "./retry_utils.js";
import { checkRateLimit, processBatch } from "./rate_limit_utils.js";

// Patterns that identify spam comments
const SPAM_PATTERNS: RegExp[] = [
  /https?:\/\/t\.me\//i,           // Telegram links
  /https?:\/\/wa\.me\//i,          // WhatsApp links
  /https?:\/\/discord\.gg\/(?!kirodotdev)[A-Za-z0-9]+/i,  // Discord invite links (unsolicited, excludes discord.gg/kirodotdev)
  /\bt\.me\/[A-Za-z0-9_]+/i,      // Telegram handles without protocol
  /join\s+(our\s+)?(telegram|whatsapp|discord)\s+(group|channel|server)/i,
  /free\s+(money|crypto|bitcoin|investment|profit)/i,
  /earn\s+\$?\d+\s+(per\s+day|daily|weekly)/i,
  /click\s+here\s+to\s+(join|earn|invest|win)/i,
];

interface SpamCheckResult {
  isSpam: boolean;
  matchedPattern?: string;
}

/**
 * Check if comment body contains spam content
 */
function isSpamComment(body: string): SpamCheckResult {
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(body)) {
      return { isSpam: true, matchedPattern: pattern.toString() };
    }
  }
  return { isSpam: false };
}

/**
 * Delete a single comment by ID
 */
async function deleteComment(
  client: Octokit,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  await retryWithBackoff(async () => {
    await client.issues.deleteComment({ owner, repo, comment_id: commentId });
  });
}

/**
 * Scan and delete spam from a single comment (event-driven mode)
 */
async function processSingleComment(
  client: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  commentBody: string,
  commentAuthor: string
): Promise<boolean> {
  const result = isSpamComment(commentBody);

  if (!result.isSpam) {
    console.log(`Comment #${commentId} by @${commentAuthor} is clean.`);
    return false;
  }

  console.log(
    `Spam detected in comment #${commentId} by @${commentAuthor}. Pattern: ${result.matchedPattern}`
  );

  await deleteComment(client, owner, repo, commentId);
  console.log(`Deleted spam comment #${commentId}`);
  return true;
}

/**
 * Bulk scan all open issue/PR comments (scheduled mode)
 */
async function bulkScanAndDelete(
  client: Octokit,
  owner: string,
  repo: string
): Promise<{ scanned: number; deleted: number }> {
  console.log(`Starting bulk spam scan for ${owner}/${repo}...`);

  let scanned = 0;
  let deleted = 0;
  let page = 1;

  while (true) {
    await checkRateLimit(client);

    const { data: comments } = await retryWithBackoff(() =>
      client.issues.listCommentsForRepo({
        owner,
        repo,
        per_page: 100,
        page,
        sort: "created",
        direction: "desc",
      })
    );

    if (comments.length === 0) break;

    console.log(`Processing page ${page} (${comments.length} comments)...`);

    const results = await processBatch(
      comments,
      10,
      async (comment) => {
        scanned++;
        const body = comment.body ?? "";
        const author = comment.user?.login ?? "unknown";
        const result = isSpamComment(body);

        if (result.isSpam) {
          console.log(
            `Spam found in comment #${comment.id} by @${author}. Pattern: ${result.matchedPattern}`
          );
          try {
            await deleteComment(client, owner, repo, comment.id);
            console.log(`Deleted comment #${comment.id}`);
            return true;
          } catch (err) {
            console.error(`Failed to delete comment #${comment.id}:`, err);
            return false;
          }
        }
        return false;
      },
      500
    );

    deleted += results.filter(Boolean).length;
    page++;
  }

  return { scanned, deleted };
}

async function main() {
  const owner = process.env.REPOSITORY_OWNER || "";
  const repo = process.env.REPOSITORY_NAME || "";
  const githubToken = process.env.GITHUB_TOKEN || "";
  const commentId = process.env.COMMENT_ID ? parseInt(process.env.COMMENT_ID) : null;
  const commentBody = process.env.COMMENT_BODY ?? "";
  const commentAuthor = process.env.COMMENT_AUTHOR ?? "unknown";
  const mode = process.env.SCAN_MODE || (commentId ? "single" : "bulk");

  if (!owner || !repo || !githubToken) {
    console.error("Missing required environment variables: REPOSITORY_OWNER, REPOSITORY_NAME, GITHUB_TOKEN");
    process.exit(1);
  }

  const client = new Octokit({ auth: githubToken });

  if (mode === "single" && commentId) {
    console.log(`=== Single Comment Spam Check (comment #${commentId}) ===`);
    const deleted = await processSingleComment(
      client, owner, repo, commentId, commentBody, commentAuthor
    );
    console.log(deleted ? "Comment deleted." : "No action taken.");

    // Write summary
    const summary = deleted
      ? `Spam comment #${commentId} by @${commentAuthor} was deleted.`
      : `Comment #${commentId} passed spam check — no action taken.`;
    console.log(`\nSummary: ${summary}`);
  } else {
    console.log(`=== Bulk Spam Scan for ${owner}/${repo} ===`);
    const { scanned, deleted } = await bulkScanAndDelete(client, owner, repo);
    console.log(`\nSummary: Scanned ${scanned} comments, deleted ${deleted} spam comments.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
