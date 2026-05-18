import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';

export async function POST(req: NextRequest) {
  try {
    const { mode } = await req.json();

    if (mode === 'cloud') {
      const githubToken = process.env.GITHUB_TOKEN; // Needed to trigger Github Actions

      if (!githubToken) {
        return NextResponse.json(
          { error: 'GITHUB_TOKEN environment variable is not set. Cannot trigger cloud loop.' },
          { status: 500 }
        );
      }

      const response = await fetch('https://api.github.com/repos/kiro358/AutoInfra/actions/workflows/flywheel.yml/dispatches', {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errText}`);
      }

      return NextResponse.json({ message: 'Cloud optimization loop triggered successfully.' });
    } else if (mode === 'local') {
      // Run local evaluation and analysis in the background
      // Because this might take a long time, we run it detached or don't await the promise
      
      const script = `npx tsx src/scripts/batch-evaluate.ts && npx tsx src/scripts/analyze-failures.ts`;
      
      exec(script, { cwd: process.cwd() }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Local Flywheel Error: ${error.message}`);
          return;
        }
        if (stderr) {
          console.error(`Local Flywheel Stderr: ${stderr}`);
        }
        console.log(`Local Flywheel Output: ${stdout}`);
      });

      return NextResponse.json({ message: 'Local optimization loop started in the background. Check server logs for progress.' });
    } else {
      return NextResponse.json({ error: 'Invalid mode. Must be "cloud" or "local".' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'An unknown error occurred.' }, { status: 500 });
  }
}
