// Loads <repo>/.env into process.env (existing variables win). No dependency
// on dotenv on purpose -- the whole project has one npm dependency (pg).
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    if (key && !(key in process.env)) process.env[key] = trimmed.slice(i + 1).trim();
  }
}

// Comma-separated env var -> lowercase, trimmed, non-empty array.
function envList(name) {
  return (process.env[name] || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = { envList };
