const mariadb = require('mariadb');
require('dotenv').config();

const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bu_motospace',
  timezone: '+07:00',
  dateStrings: true,
  connectionLimit: 10,
  acquireTimeout: 30000,
});

module.exports = pool;
