const { Pool } = require('pg');

// Read DATABASE_URL from environment variables
const databaseUrl = process.env.DATABASE_URL;

// Create and export a pg Pool instance
const pool = new Pool({
  connectionString: databaseUrl,
});

// Handle errors appropriately
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;