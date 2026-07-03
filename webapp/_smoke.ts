import fs from 'fs'; import path from 'path';
import { renderTilesFlat } from './src/lib/rasterize';
import { extractFromPDF } from './src/lib/extraction';
const dir='/Users/kirolosyoussef/Github/AutoInfra/existing_projects_training_data/2026-067 201 GEORGIAN DR,BARRIE';
const pdf=path.join(dir,'Appendix 1.00 AMCAI Civil Plan Set (1).pdf');
(async()=>{
  const tiles=await renderTilesFlat(fs.readFileSync(pdf),[2],{dpi:150,tilePx:1600,overlapPx:160});
  const kb=tiles.map(b=>Math.round(b.length/1024));
  console.log(`JPEG tiles: ${tiles.length}, avg ${Math.round(kb.reduce((a,b)=>a+b,0)/kb.length)}KB (was ~600KB PNG), total ${Math.round(tiles.reduce((a,b)=>a+b.length,0)/1024)}KB`);
  const t0=Date.now();
  const f=await extractFromPDF([fs.readFileSync(pdf)],'2026-067 201 GEORGIAN DR,BARRIE');
  console.log(`extract ${((Date.now()-t0)/1000).toFixed(0)}s: structures=${f.structures.length} runs=${f.sewers.filter(s=>!s.isLineItem).length}`);
  console.log('  labels:', f.structures.map(s=>s.description).slice(0,8).join(', '));
  console.log('  runs:', f.sewers.filter(s=>!s.isLineItem).map(s=>`${s.runLabel}(${s.length}m/${s.pipeDiameter})`).slice(0,6).join(', '));
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
