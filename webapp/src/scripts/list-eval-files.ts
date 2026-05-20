import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';

async function main() {
  const bucket = storage.bucket(BUCKET_NAME);
  
  console.log('Listing scoreboard files:');
  const [files] = await bucket.getFiles({ prefix: 'scoreboards/' });
  files.forEach(f => console.log(`- ${f.name} (${(Number(f.metadata.size || 0) / 1024).toFixed(2)} KB, updated: ${f.metadata.updated})`));
  
  console.log('\nListing files for 2026-069 RIOCAN GEORGIAN MALL:');
  const [riocanFiles] = await bucket.getFiles({ prefix: '2026-069 RIOCAN GEORGIAN MALL/' });
  riocanFiles.forEach(f => console.log(`- ${f.name} (${(Number(f.metadata.size || 0) / 1024).toFixed(2)} KB, updated: ${f.metadata.updated})`));
}

main().catch(console.error);
