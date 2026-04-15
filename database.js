require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    appName: 'GERTEC',
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 3000 },
};

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

pool.on('error', err => console.error('❌ Erro SQL Server:', err.message));

poolConnect.then(() => {
  console.log(`Conectado: ${process.env.DB_SERVER},${process.env.DB_PORT} — ${process.env.DB_DATABASE}`);
}).catch(err => {
  console.error('Falha ao conectar:', err.message);
});

async function query(queryStr, params = {}) {
  await poolConnect;
  const request = pool.request();
  for (const [key, val] of Object.entries(params)) request.input(key, val);
  const result = await request.query(queryStr);
  return result.recordset;
}

async function queryOne(queryStr, params = {}) {
  const rows = await query(queryStr, params);
  return rows[0] || null;
}

module.exports = { sql, pool, poolConnect, query, queryOne };
