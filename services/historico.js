/* ════════════════════════════════════════════════════════════════════════════
 *  Histórico de leituras — serviço independente (sobre SQLite)
 *  ----------------------------------------------------------------------------
 *  Fonte ÚNICA do histórico consolidado das leituras de todos os terminais,
 *  agora persistido no SQLite unificado (services/db.js) — histórico E impressões
 *  na mesma tabela. Este módulo não sabe NADA de WebSocket/Socket.IO/HTTP.
 *
 *  EventEmitter:
 *    - 'nova'     (leitura)  → leitura nova registrada
 *    - 'impresso' (id)       → leitura marcada como impressa
 *    - 'limpo'               → histórico zerado
 *
 *  Consumidores (desacoplados): ponte Socket.IO + HTTP (server.js) e o
 *  WebSocket do app (services/appHistoricoWS.js).
 * ════════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const EventEmitter = require('events');
const db = require('./db');

const LIMITE_PADRAO = 200; // teto de leitura (o front trabalha com ~200)

// Statements preparados (reuso = rápido)
const stmtInserir = db.prepare(`
    INSERT INTO leituras (id, ts, terminal, serial, codigo, nome, preco, hora, status)
    VALUES (@id, @ts, @terminal, @serial, @codigo, @nome, @preco, @hora, @status)
`);
const stmtRecentes = db.prepare(`
    SELECT id, ts, terminal, serial, codigo, nome, preco, hora, status,
           impresso, impresso_em
    FROM leituras ORDER BY seq DESC LIMIT ?
`);
const stmtLimpar = db.prepare('DELETE FROM leituras');
const stmtImpressos = db.prepare('SELECT id FROM leituras WHERE impresso = 1');

// Variantes de um código EAN para casar com o que os terminais gravaram
// (TC põe '0' na frente de 12 dígitos; BP faz padStart(13); ambos têm fallback
// "sem zeros à esquerda"). Comparar por todas evita criar leitura duplicada do app.
function variantesEAN(codigoBruto) {
    const c = String(codigoBruto || '').trim();
    if (!c) return [];
    const base = c.replace(/^0+/, '') || c; // sem zeros à esquerda (nunca vazio)
    const set = new Set([c, base, '0' + c, '0' + base]);
    for (const n of [12, 13, 14]) set.add(base.padStart(n, '0'));
    return [...set].filter(Boolean);
}
const stmtMarcar = db.prepare(
    `UPDATE leituras SET impresso = 1, impresso_em = @em WHERE id = @id AND impresso = 0`);

class Historico extends EventEmitter {
    // Lista mais novas primeiro (mesma ordem que o front espera). `impresso` vira bool.
    lerTudo(limite = LIMITE_PADRAO) {
        const rows = stmtRecentes.all(limite);
        return rows.map(r => ({ ...r, impresso: !!r.impresso }));
    }

    // Registra uma leitura. Gera id/ts se faltarem (compat) e devolve a leitura
    // (quem chamou usa leitura.id depois). Emite 'nova'.
    registrar(leitura) {
        if (!leitura.id) leitura.id = crypto.randomUUID();
        if (!leitura.ts) leitura.ts = new Date().toISOString();
        stmtInserir.run({
            id: String(leitura.id),
            ts: leitura.ts,
            terminal: leitura.terminal || null,
            serial: leitura.serial || null,
            codigo: leitura.codigo || null,
            nome: leitura.nome || null,
            preco: leitura.preco || null,
            hora: leitura.hora || null,
            status: leitura.status || null,
        });
        this.emit('nova', leitura);
        return leitura;
    }

    // Marca como impressa. Retorna true se mudou algo. Emite 'impresso'.
    marcarImpresso(id) {
        if (!id) return false;
        const r = stmtMarcar.run({ id: String(id), em: new Date().toISOString() });
        if (r.changes > 0) { this.emit('impresso', id); return true; }
        return false;
    }

    // IDs das leituras já impressas (compat com /api/impressos e o front).
    lerImpressos() {
        return stmtImpressos.all().map(r => r.id);
    }

    // Leitura mais recente de um código (ou null), casando por todas as variantes
    // de zeros à esquerda. Usado p/ anexar a impressão do app a uma consulta já
    // existente (de um terminal), sem criar uma "consulta do app".
    ultimaPorCodigo(codigo) {
        const vars = variantesEAN(codigo);
        if (!vars.length) return null;
        const ph = vars.map(() => '?').join(',');
        const row = db.prepare(
            `SELECT id, impresso FROM leituras WHERE codigo IN (${ph}) ORDER BY seq DESC LIMIT 1`
        ).get(...vars);
        return row || null;
    }

    limpar() {
        stmtLimpar.run();
        this.emit('limpo');
    }
}

// Singleton: todos compartilham a MESMA instância (e os eventos).
module.exports = new Historico();
