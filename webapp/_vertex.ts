import path from 'path'; import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { renderTilesFlat, IMAGE_MIME } from './src/lib/rasterize';
import { getSinglePassPrompt } from './src/lib/modular-prompts';
import { tryParseJSONWithRepair } from './src/lib/extraction';
const base = path.resolve('..','existing_projects_training_data','2026-005 ONTARIO TECH UNIVERSITY STUDENT COMMUNITY BLDG 1A & 1B');
const PDF = path.join(base,'25-12-15 UOIT Phase 1-SW2-Servicing Plan.pdf');
const ai = new GoogleGenAI({ vertexai:true, project:'autoinfra-ai', location:'us-central1', httpOptions:{ timeout:290000 } });
async function trial(label:string, maxOut?:number){
  const tiles = await renderTilesFlat(fs.readFileSync(PDF),[1],{dpi:150,tilePx:1600,overlapPx:160,maxTilesPerPage:16,maxTilesTotal:16});
  const media = tiles.map(t=>({inlineData:{mimeType:IMAGE_MIME,data:t.toString('base64')}}));
  const cfg:any={temperature:0,responseMimeType:'application/json'}; if(maxOut)cfg.maxOutputTokens=maxOut;
  let acc='',finish='',outTok=0,thoughtTok=0;
  const s = await ai.models.generateContentStream({ model:'gemini-2.5-flash', contents:[{role:'user',parts:[{text:getSinglePassPrompt('OT','')},...media]}], config:cfg });
  for await(const c of s){ acc+=c.text||''; const fr=c.candidates?.[0]?.finishReason; if(fr)finish=fr; const u=c.usageMetadata; if(u){outTok=u.candidatesTokenCount||outTok; thoughtTok=(u as any).thoughtsTokenCount||thoughtTok;} }
  let j:any={}; try{j=tryParseJSONWithRepair(acc);}catch{}
  console.log(`${label}: finish=${finish} outTok=${outTok} thoughtTok=${thoughtTok} rawLen=${acc.length} | pipeScan=${(j.pipeScan||[]).length} sewers=${(j.sewers||[]).length} manholes=${(j.manholes||[]).length}`);
  if(!Object.keys(j).length) console.log('   RAW head:', acc.slice(0,200));
}
(async()=>{ await trial('VERTEX default ', undefined); await trial('VERTEX maxOut=32768', 32768); console.log('(truth sewers=36 structs=25; AI Studio gave 34/25)'); })();
