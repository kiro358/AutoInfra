/**
 * flywheel-rollback.ts
 *
 * Emergency rollback for flywheel-managed files.
 * Reverts dynamic-rules.json and few_shot_examples.json to their
 * last git-committed version, or to a specific commit.
 *
 * Usage:
 *   npx tsx src/scripts/flywheel-rollback.ts              # Revert to last commit
 *   npx tsx src/scripts/flywheel-rollback.ts --to <sha>   # Revert to specific commit
 *   npx tsx src/scripts/flywheel-rollback.ts --list        # Show recent flywheel commits
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FILES_TO_ROLLBACK = [
  'webapp/src/lib/dynamic-rules.json',
  'few_shot_examples.json',
];

function run(cmd: string): string {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function listRecentFlywheelCommits() {
  console.log('📜 Recent commits touching flywheel-managed files:\n');
  const log = run(
    `git log --oneline -10 -- ${FILES_TO_ROLLBACK.join(' ')}`
  );
  if (!log) {
    console.log('   No commits found for these files.');
  } else {
    console.log(log);
  }
}

function rollback(targetCommit?: string) {
  const target = targetCommit || 'HEAD';
  
  console.log(`🔄 Rolling back flywheel files to: ${target}\n`);

  for (const file of FILES_TO_ROLLBACK) {
    const fullPath = path.join(REPO_ROOT, file);
    try {
      // Check if file exists in the target commit
      const content = run(`git show ${target}:${file}`);
      fs.writeFileSync(fullPath, content);
      console.log(`   ✅ Restored: ${file}`);
    } catch (e: any) {
      if (e.message.includes('does not exist') || e.message.includes('fatal')) {
        console.log(`   ⚠️ File not found in ${target}: ${file} (skipping)`);
      } else {
        console.error(`   ❌ Error restoring ${file}: ${e.message}`);
      }
    }
  }

  // Clean up candidate files if they exist
  const candidateFiles = [
    'webapp/src/lib/dynamic-rules.candidate.json',
    'few_shot_examples.candidate.json',
  ];
  for (const f of candidateFiles) {
    const fullPath = path.join(REPO_ROOT, f);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`   🗑️ Removed candidate: ${f}`);
    }
  }

  console.log('\n✅ Rollback complete. Run your evaluation to verify accuracy.');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    listRecentFlywheelCommits();
    return;
  }

  const toIndex = args.indexOf('--to');
  if (toIndex !== -1 && args[toIndex + 1]) {
    rollback(args[toIndex + 1]);
  } else {
    rollback(); // Default: HEAD
  }
}

main();
