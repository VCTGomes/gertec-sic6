/* ════════════════════════════════════════════════════════════════════════════
 *  Impressões de etiqueta — histórico unificado (sobre SQLite)
 *  ----------------------------------------------------------------------------
 *  Fonte ÚNICA do "o que já foi impresso, quando e por qual preço", vindo de
 *  qualquer origem: aba Precificação do ESTOQUE, app SIC Printer e terminais.
 *
 *  É isso que permite comparar o preço atual do SIC com o preço que está de
 *  fato na etiqueta da gôndola.
 *
 *  Retenção: 7 dias. A limpeza roda na carga do módulo e de hora em hora.
 * ════════════════════════════════════════════════════════════════════════════ */

const db = require('./db');

const DIAS_RETENCAO = 7;
const LIMITE_PADRAO = 500;

// Código sem zeros à esquerda — os terminais gravam com padding (padStart 12/13/14)
// e o ESTOQUE grava o código cru do tabest1. Normalizar na escrita e na leitura
// faz os dois casarem sem precisar testar variante por variante.
function normalizar(codigo) {
    const c = String(codigo ?? '').trim();
    if (!c) return '';
    return c.replace(/^0+/, '') || c;
}

// ISO de N dias atrás (retenção — janela corrida, só para a purga)
function isoDiasAtras(dias) {
    return new Date(Date.now() - dias * 86400_000).toISOString();
}

// ISO da meia-noite local de N-1 dias atrás — dias=1 devolve o início de hoje.
// A consulta é por DIA de calendário, igual à janela da aba Precificação
// (services/precificacao.js), senão "Hoje" traria impressões de ontem à noite.
function isoInicioDoDia(dias) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (dias - 1));
    return d.toISOString();
}

const stmtInserir = db.prepare(`
    INSERT INTO impressoes (ts, codigo, codigo_norm, nome, preco, origem)
    VALUES (@ts, @codigo, @codigo_norm, @nome, @preco, @origem)
`);
const stmtListar = db.prepare(`
    SELECT seq, ts, codigo, nome, preco, origem
    FROM impressoes
    WHERE ts >= ?
    ORDER BY seq DESC
    LIMIT ?
`);
const stmtPurgar = db.prepare('DELETE FROM impressoes WHERE ts < ?');

// Registra uma impressão. `preco` em número (aceita "R$ 9,50" e "9,50").
function registrar({ codigo, nome, preco, origem }) {
    const cod = String(codigo ?? '').trim();
    if (!cod) return null;

    const reg = {
        ts:          new Date().toISOString(),
        codigo:      cod,
        codigo_norm: normalizar(cod),
        nome:        nome ? String(nome).trim() : null,
        preco:       parsePreco(preco),
        origem:      origem || null,
    };
    stmtInserir.run(reg);
    return reg;
}

// "R$ 9,50" | "9,50" | 9.5 → 9.5 (null quando não dá para interpretar)
function parsePreco(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const limpo = String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(limpo);
    return Number.isFinite(n) ? n : null;
}

// Impressões dos últimos `dias` (teto de 7 — não há dado além disso).
function listar(dias = DIAS_RETENCAO, limite = LIMITE_PADRAO) {
    const d = Math.min(Math.max(parseInt(dias) || DIAS_RETENCAO, 1), DIAS_RETENCAO);
    return stmtListar.all(isoInicioDoDia(d), Math.max(parseInt(limite) || LIMITE_PADRAO, 1));
}

// Última impressão de cada código pedido, dentro da janela de retenção.
// Devolve { [codigoNormalizado]: { ts, preco, nome, origem } } — o consumidor
// normaliza a chave do mesmo jeito (função `normalizar` exportada).
function ultimasPorCodigos(codigos = []) {
    const normais = [...new Set(codigos.map(normalizar).filter(Boolean))];
    if (!normais.length) return {};

    const mapa = {};
    // Em blocos: SQLite tem teto de variáveis por statement (padrão 999).
    for (let i = 0; i < normais.length; i += 500) {
        const bloco = normais.slice(i, i + 500);
        const ph = bloco.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT codigo_norm, ts, preco, nome, origem
            FROM impressoes
            WHERE codigo_norm IN (${ph})
            ORDER BY seq ASC
        `).all(...bloco);
        // ASC + sobrescrita → sobra a mais recente de cada código
        for (const r of rows) {
            mapa[r.codigo_norm] = { ts: r.ts, preco: r.preco, nome: r.nome, origem: r.origem };
        }
    }
    return mapa;
}

function purgar() {
    const r = stmtPurgar.run(isoDiasAtras(DIAS_RETENCAO));
    if (r.changes > 0) console.log(`[IMPRESSOES] Retenção: ${r.changes} registro(s) além de ${DIAS_RETENCAO} dias removido(s).`);
    return r.changes;
}

purgar();
setInterval(purgar, 3600_000).unref();

module.exports = { registrar, listar, ultimasPorCodigos, normalizar, purgar, DIAS_RETENCAO };
