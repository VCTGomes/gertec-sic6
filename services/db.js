/* ════════════════════════════════════════════════════════════════════════════
 *  Banco SQLite unificado (data/gertec.db)
 *  ----------------------------------------------------------------------------
 *  Substitui os JSON soltos (bdTempLeitura.json + bdImpressos.json) por um único
 *  SQLite confiável (escrita atômica, WAL). A flag "impresso" vira coluna da
 *  própria leitura — unifica histórico e impressões numa só tabela.
 *
 *  Na primeira execução, migra automaticamente o conteúdo dos JSON antigos e os
 *  renomeia para .migrado.bak (ficam como backup, não são mais lidos).
 * ════════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Diretório de dados (override por env facilita testes isolados)
const DATA_DIR = process.env.GERTEC_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'historico.db');
const JSON_LEITURAS = path.join(DATA_DIR, 'temp', 'bdTempLeitura.json');
const JSON_IMPRESSOS = path.join(DATA_DIR, 'temp', 'bdImpressos.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // durabilidade + leitura concorrente
db.pragma('synchronous = NORMAL'); // bom equilíbrio segurança/throughput com WAL

db.exec(`
    CREATE TABLE IF NOT EXISTS leituras (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- ordem de chegada (estável)
        id          TEXT UNIQUE NOT NULL,               -- UUID p/ rastrear impressão
        ts          TEXT NOT NULL,                      -- ISO-8601 do servidor
        terminal    TEXT,
        serial      TEXT,
        codigo      TEXT,
        nome        TEXT,
        preco       TEXT,
        hora        TEXT,                               -- compat com o front (HH:MM:SS)
        status      TEXT,                               -- 'ok' | 'erro'
        impresso    INTEGER NOT NULL DEFAULT 0,         -- 0/1
        impresso_em TEXT                                -- ISO quando impresso (ou NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_leituras_codigo ON leituras(codigo);
`);

// ── Migração única dos JSON antigos ───────────────────────────────────────────
function migrarDosJson() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM leituras').get().n;
    if (total > 0) return; // já tem dados → não migra de novo

    let leituras = [];
    try {
        if (fs.existsSync(JSON_LEITURAS)) leituras = JSON.parse(fs.readFileSync(JSON_LEITURAS, 'utf8'));
    } catch (e) { console.error('[DB] Falha ao ler bdTempLeitura.json:', e.message); }

    let impressos = [];
    try {
        if (fs.existsSync(JSON_IMPRESSOS)) impressos = JSON.parse(fs.readFileSync(JSON_IMPRESSOS, 'utf8'));
    } catch (e) { console.error('[DB] Falha ao ler bdImpressos.json:', e.message); }

    if (!leituras.length && !impressos.length) return;

    const setImpressos = new Set(impressos);
    const ins = db.prepare(`
        INSERT OR IGNORE INTO leituras (id, ts, terminal, serial, codigo, nome, preco, hora, status, impresso)
        VALUES (@id, @ts, @terminal, @serial, @codigo, @nome, @preco, @hora, @status, @impresso)
    `);

    // O JSON guardava do mais novo p/ o mais antigo (unshift). Inserimos ao
    // contrário p/ o `seq` crescer na ordem cronológica (mais novo = maior seq).
    const cron = leituras.slice().reverse();
    const tx = db.transaction((arr) => {
        for (const l of arr) {
            if (!l || !l.id) continue;
            ins.run({
                id: String(l.id),
                ts: l.ts || (l.hora ? null : null) || new Date().toISOString(),
                terminal: l.terminal || null,
                serial: l.serial || null,
                codigo: l.codigo || null,
                nome: l.nome || null,
                preco: l.preco || null,
                hora: l.hora || null,
                status: l.status || null,
                impresso: setImpressos.has(l.id) ? 1 : 0,
            });
        }
    });
    tx(cron);

    const n = db.prepare('SELECT COUNT(*) AS n FROM leituras').get().n;
    console.log(`[DB] Migração concluída: ${n} leituras importadas dos JSON.`);

    // Renomeia os JSON antigos para backup (não são mais usados).
    for (const f of [JSON_LEITURAS, JSON_IMPRESSOS]) {
        try { if (fs.existsSync(f)) fs.renameSync(f, f + '.migrado.bak'); } catch (e) { /* ok */ }
    }
}

migrarDosJson();

module.exports = db;
