require('./env.js');
const { Client } = require('pg');

async function getClient() {
  const client = new Client(); // picks up PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from .env
  await client.connect();
  return client;
}

module.exports = { getClient };
