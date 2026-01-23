# Testing GitHub Issue Triage Workflow Locally

This guide explains how to test the complete issue triage workflow on real GitHub issues from your local machine.

## Prerequisites

1. **Environment variables configured** in `scripts/.env`:
   - `AWS_ACCESS_KEY_ID` - AWS credentials for Bedrock
   - `AWS_SECRET_ACCESS_KEY` - AWS credentials for Bedrock
   - `AWS_REGION` - AWS region (default: us-east-1)
   - `GITHUB_TOKEN` - GitHub personal access token with repo access
   - `REPOSITORY_OWNER` - GitHub repository owner (default: kirodotdev)
   - `REPOSITORY_NAME` - GitHub repository name (default: Kiro)

2. **Dependencies installed**:
   ```bash
   cd scripts
   npm install
   ```

## Method 1: Using the Shell Script (Recommended)

The easiest way to test:

```bash
cd scripts/test
./test-real-issue.sh <issue_number>
```

Example:
```bash
./test-real-issue.sh 5066
```

This will:
1. Load environment variables from `.env`
2. Build the TypeScript code
3. Fetch the issue details from GitHub
4. Run the complete triage workflow
5. Show results

## Method 2: Using Node Directly

```bash
cd scripts

# Build TypeScript
npm run build

# Load env vars and run test (excluding ISSUE_NUMBER from .env)
export $(cat .env | grep -v '^#' | grep -v '^ISSUE_NUMBER' | xargs)
export TEST_ISSUE_NUMBER=5066
node dist/test/test-real-issue.js
```

## Method 3: Manual Workflow Execution

To run the triage script directly (like GitHub Actions does):

```bash
cd scripts

# Build
npm run build

# Set environment variables
export $(cat .env | grep -v '^#' | xargs)
export ISSUE_NUMBER=5066
export ISSUE_TITLE="Your issue title"
export ISSUE_BODY="Your issue body"

# Run triage
node dist/triage_issue.js
```

## What Gets Tested

The workflow performs these steps:

1. **Classification** - Uses AWS Bedrock Claude to classify the issue and recommend labels
2. **Label Assignment** - Assigns recommended labels to the issue
3. **Duplicate Detection** - Searches all open issues for potential duplicates
4. **Duplicate Comment** - Posts a comment if duplicates are found (≥80% similarity)
5. **Duplicate Label** - Adds "duplicate" label and removes "pending-triage" label

## Verifying Results

After running the test, check the GitHub issue to verify:

1. **Labels added**: Check if recommended labels were applied
2. **Duplicate comment**: Look for "Potential Duplicate Issues Detected" comment
3. **Duplicate label**: If duplicates found, "duplicate" label should be added
4. **Pending-triage removed**: If duplicate label added, "pending-triage" should be removed

## Example Output

```
╔════════════════════════════════════════════════════════════╗
║         Real Issue Triage Test (Local Simulation)         ║
╚════════════════════════════════════════════════════════════╝

Repository: kirodotdev/kiro
Issue Number: #5066

=== Triaging Issue #5066 ===
Title: Getting Authorization error - unable to proceed

Step 1: Classifying issue with AWS Bedrock...
Recommended labels: auth, os: mac, theme:unexpected-error, pending-triage

Step 2: Assigning labels...
✅ Successfully assigned labels

Step 3: Detecting duplicate issues...
Found 2 potential duplicates

Step 4: Posting duplicate comment...
✅ Successfully posted duplicate comment

Step 5: Adding duplicate label...
✅ Successfully added duplicate label
✅ Successfully removed pending-triage label

=== Triage Complete ===
```

## Troubleshooting

### "GITHUB_TOKEN not set"
Make sure your `.env` file has a valid GitHub token with repo access.

### "AWS credentials not set"
Ensure AWS credentials are configured in `.env` file.

### "Issue not found"
- Verify the issue number exists
- Check you have access to the repository
- Ensure the repository owner/name are correct

### "Label does not exist"
This is normal if the issue doesn't have the "pending-triage" label. The script handles this gracefully.

## Notes

- The script makes real changes to GitHub issues (adds labels, posts comments)
- Use test issues or your own repository for testing
- The duplicate detection searches the last 100 open issues
- Similarity threshold is 80% for duplicate detection
