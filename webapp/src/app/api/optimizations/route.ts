import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // 1. Read Dynamic Rules & Heuristics
    let dynamicRulesPath = path.resolve(process.cwd(), 'src/lib/dynamic-rules.json');
    if (!fs.existsSync(dynamicRulesPath)) {
      dynamicRulesPath = path.resolve(process.cwd(), 'webapp/src/lib/dynamic-rules.json');
    }

    let promptAdditions: string[] = [];
    let heuristics: string[] = [];

    if (fs.existsSync(dynamicRulesPath)) {
      const data = JSON.parse(fs.readFileSync(dynamicRulesPath, 'utf8'));
      promptAdditions = data.promptAdditions || [];
      heuristics = data.heuristics || [];
    }

    // 2. Read Few Shot Examples Count
    let fewShotPath = path.resolve(process.cwd(), 'few_shot_examples.json');
    if (!fs.existsSync(fewShotPath)) {
      fewShotPath = path.resolve(process.cwd(), 'webapp/few_shot_examples.json');
    }

    let fewShotCount = 0;
    let fewShotProjects: string[] = [];

    if (fs.existsSync(fewShotPath)) {
      try {
        const fewShots = JSON.parse(fs.readFileSync(fewShotPath, 'utf8'));
        if (Array.isArray(fewShots)) {
          fewShotCount = fewShots.length;
          fewShotProjects = fewShots.map((ex: any) => ex.projectName || 'Unnamed Project').filter(Boolean);
        }
      } catch (e) {
        console.error('Failed to parse few_shot_examples.json', e);
      }
    }

    return NextResponse.json({
      success: true,
      promptAdditions,
      heuristics,
      fewShotCount,
      fewShotProjects
    });
  } catch (error: any) {
    console.error('Error fetching optimizations data:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Unknown error occurred while fetching optimizations data'
    }, { status: 500 });
  }
}
