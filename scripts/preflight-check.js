import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
const examplePath = path.resolve(process.cwd(), '.env.example');

const report = {
  envFile: fs.existsSync(envPath),
  envExample: fs.existsSync(examplePath),
  contractFile: fs.existsSync(path.resolve(process.cwd(), 'contracts/MemoryEvents.sol')),
  serverFile: fs.existsSync(path.resolve(process.cwd(), 'apps/arena/src/server.js'))
};

if (!report.envFile && report.envExample) {
  console.log('⚠️ Missing .env, copy from .env.example before running.');
}

console.table(report);
