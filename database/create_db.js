/**
 * Create the bu_motospace database and grant privileges.
 * This script connects as root to create the database.
 */
const mariadb = require('mariadb');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function createDB() {
  let conn;
  try {
    // Connect as root
    conn = await mariadb.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT) || 3036,
      user: 'root',
      password: process.env.DB_PASSWORD || '',
      connectTimeout: 5000,
    });
    console.log('Connected as root');

    await conn.query('CREATE DATABASE IF NOT EXISTS bu_motospace CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log('Database bu_motospace created');

    const dbUser = process.env.DB_USER || 'asset_user';
    try {
      await conn.query("GRANT ALL PRIVILEGES ON bu_motospace.* TO '" + dbUser + "'@'%'");
      await conn.query('FLUSH PRIVILEGES');
      console.log('Privileges granted to ' + dbUser);
    } catch(e) {
      console.log('Grant warning:', e.message);
    }

    conn.end();
    console.log('Done! Now run: node database/setup.js');
  } catch (err) {
    console.error('Failed:', err.code, err.message);
    if (conn) conn.end();
    process.exit(1);
  }
}

createDB();
