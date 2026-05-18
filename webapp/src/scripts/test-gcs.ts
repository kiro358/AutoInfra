import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';

async function main() {
  console.log(`Checking GCS access for bucket: ${BUCKET_NAME}`);
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const fileName = `test-connection-${Date.now()}.txt`;
    const file = bucket.file(fileName);
    
    console.log('Uploading test file...');
    await file.save('Hello from AutoInfra connection test!', {
      contentType: 'text/plain',
    });
    console.log('✅ Upload successful.');

    console.log('Deleting test file...');
    await file.delete();
    console.log('✅ Delete successful. GCS permissions are fully functional!');
  } catch (e: any) {
    console.error('❌ GCS connection test failed:', e.message);
  }
}

main();
