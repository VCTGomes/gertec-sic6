const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // .env fica na mesma pasta deste arquivo
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
  // min:1 mantém uma conexão quente (evita derrubar/recriar o pool a cada poucos segundos);
  // idleTimeoutMillis maior evita o "thrash" que o valor antigo (3s) causava.
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
};

let pool = null;        // pool atual; pode ser recriado quando a conexão cai
let connecting = null;  // promessa de conexão em andamento (evita conexões concorrentes)

// Erros que indicam "conexão caiu" — nesses casos vale recriar o pool e tentar de novo.
// Erros de SQL reais (sintaxe, permissão, etc.) NÃO entram aqui: repetir não adianta.
function isConnectionError(err) {
  const code = err && (err.code || (err.originalError && err.originalError.code));
  return ['ECONNCLOSED', 'ECONNRESET', 'ESOCKET', 'ETIMEOUT', 'ELOGIN', 'ENOTOPEN']
           .includes(code)
         || /closed|terminat|not connected|connection.*(lost|reset)/i.test((err && err.message) || '');
}

async function connectOnce() {
  const p = new sql.ConnectionPool(config);
  p.on('error', err => {
    console.error('❌ Erro no pool SQL:', err.message);
    if (pool === p) pool = null; // invalida para forçar reconexão na próxima query
  });
  await p.connect();
  return p;
}

// Conecta com retry/backoff. NÃO fica rejeitado pra sempre: a cada nova query
// que chama getPool() uma nova rodada de tentativas é disparada.
async function connectWithRetry(maxTentativas = 10) {
  let ultimo;
  for (let t = 1; t <= maxTentativas; t++) {
    try {
      const p = await connectOnce();
      console.log(`Conectado: ${config.server},${config.port} — ${config.database}`);
      return p;
    } catch (err) {
      ultimo = err;
      const espera = Math.min(15000, 1000 * Math.pow(2, Math.min(t, 4))); // backoff até 15s
      console.error(`Falha ao conectar (tentativa ${t}/${maxTentativas}): ${err.message}. Retry em ${espera / 1000}s`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw ultimo;
}

async function getPool() {
  if (pool && pool.connected) return pool;
  if (!connecting) {
    connecting = connectWithRetry()
      .then(p => { pool = p; return p; })
      .finally(() => { connecting = null; });
  }
  return connecting;
}

// Dispara a conexão já no boot, mas sem derrubar o processo se o SQL ainda não subiu.
const poolConnect = getPool().catch(err =>
  console.error('Boot sem SQL ainda (vai reconectar sob demanda):', err.message));

async function query(queryStr, params = {}) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const p = await getPool();
      const request = p.request();
      for (const [key, val] of Object.entries(params)) request.input(key, val);
      const result = await request.query(queryStr);
      return result.recordset;
    } catch (err) {
      ultimoErro = err;
      if (isConnectionError(err)) {
        console.error(`Query falhou por conexão (tentativa ${tentativa}/2): ${err.message}. Reconectando...`);
        pool = null;        // invalida e força novo pool na próxima volta
        connecting = null;
        continue;
      }
      throw err;            // erro de SQL real — propaga sem repetir
    }
  }
  throw ultimoErro;
}

async function queryOne(queryStr, params = {}) {
  const rows = await query(queryStr, params);
  return rows[0] || null;
}

module.exports = {
  sql,
  poolConnect,
  query,
  queryOne,
  get pool() { return pool; }, // compat: ninguém usa direto hoje, mas mantém a API
};
