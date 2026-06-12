const mysql = require('mysql2');
require('dotenv').config();

const readEnv = (key, removeWhitespace = false) => {
  const value = String(process.env[key] || '').trim().replace(/^['"]|['"]$/g, '');
  return removeWhitespace ? value.replace(/\s/g, '') : value;
};

const dbConfig = {
  host: readEnv('DB_HOST'),
  user: readEnv('DB_USER'),
  password: readEnv('DB_PASSWORD'),
  database: readEnv('DB_NAME'),
  port: parseInt(readEnv('DB_PORT'), 10) || 24231,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: { rejectUnauthorized: false },
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
};

const pool = mysql.createPool(dbConfig);
pool.safeConfig = {
  host: dbConfig.host,
  database: dbConfig.database,
  port: dbConfig.port,
  userLoaded: Boolean(dbConfig.user),
  passwordLoaded: Boolean(dbConfig.password)
};

module.exports = pool;
