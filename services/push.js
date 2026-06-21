const fs   = require('fs');
const path = require('path');
const { queryOne } = require('../database');
const db = require('./db'); // SQLite local (historico.db) — guarda nossa config

// ════════════════════════════════════════════════════════════════════════════
//  PUSH — serviço unificado (busca-preco / sicprinter.vctgomes.com)
//  ----------------------------------------------------------------------------
//  O serviço na nuvem agora GUARDA os tokens, RENDERIZA os eventos (título/corpo/
//  botões) e entrega por TÓPICO (`instalation-<id>`). Este módulo deixa de manter
//  keys.json e de mandar tokens: ele só (1) faz proxy do subscribe/refresh dos
//  navegadores (CORS) e (2) dispara eventos por instalação.
//
//  Autenticação dos disparos (`/api/push/event`) é por PERTENCIMENTO: o device_id
//  que dispara precisa ser membro da instalação (ter feito /subscribe). Como o
//  backend não é um navegador com token FCM, ele reaproveita os device_id que
//  passaram pelo proxy do subscribe (guardados em data/push/membros.json) e, ao
//  receber 403, descarta o membro inválido e tenta o próximo.
// ════════════════════════════════════════════════════════════════════════════

const PUSH_BASE    = (process.env.PUSH_BASE_URL || 'https://sicprinter.vctgomes.com').replace(/\/+$/, '');
const MEMBROS_PATH = path.join(__dirname, '..', 'data', 'push', 'membros.json');

// ── Config local (historico.db) ───────────────────────────────────────────────
// Tabela chave/valor para guardar config NOSSA (ex.: um instalationId gerado
// quando o cliente ainda não tem um). NUNCA escrevemos no SQL do cliente.
db.exec(`CREATE TABLE IF NOT EXISTS CONFIG (chave TEXT PRIMARY KEY, valor TEXT)`);
const stmtGetConfig = db.prepare(`SELECT valor FROM CONFIG WHERE chave = ?`);
const stmtSetConfig = db.prepare(`
    INSERT INTO CONFIG (chave, valor) VALUES (@chave, @valor)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
function getConfig(chave) { const r = stmtGetConfig.get(chave); return r ? r.valor : null; }
function setConfig(chave, valor) { stmtSetConfig.run({ chave, valor: String(valor) }); }

// ── instalation_id ────────────────────────────────────────────────────────────
// Credencial dos eventos (1–10 chars [A-Za-z0-9]).
// Fonte da verdade: SQL do cliente (TABARQUIVOS IDENT='SIC_PRINTER' → TEXTO JSON →
// `instalationId`) — só LEITURA, nunca escrevemos lá. Se o cliente ainda não tem
// um, geramos um NOSSO e guardamos no historico.db (CONFIG), reaproveitando depois.
let cacheInstalationId = null;

function sanitizarId(v) {
    return String(v || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
}

function gerarId() {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const buf = require('crypto').randomBytes(10);
    let s = '';
    for (let i = 0; i < 10; i++) s += abc[buf[i] % abc.length];
    return s;
}

async function instalationId() {
    if (cacheInstalationId) return cacheInstalationId;

    // 1) Fonte da verdade: SQL do cliente (apenas leitura).
    try {
        const row = await queryOne(
            `SELECT TOP 1 TEXTO FROM TABARQUIVOS WHERE IDENT = 'SIC_PRINTER'`);
        const texto = row && row.TEXTO != null ? String(row.TEXTO) : null;
        let idSql = null;
        if (texto) {
            try { idSql = sanitizarId((JSON.parse(texto) || {}).instalationId); }
            catch { idSql = null; }
        }
        if (idSql) { cacheInstalationId = idSql; return idSql; }
    } catch (e) {
        // SQL indisponível: não geramos um novo aqui (o cliente pode ter um id que
        // só não conseguimos ler agora). Usa o local se já existir; senão, espera.
        console.error('[PUSH] Falha ao ler instalationId do SQL:', e.message);
        const local = sanitizarId(getConfig('instalationId'));
        if (local) { cacheInstalationId = local; return local; }
        return null;
    }

    // 2) Cliente não tem instalationId no SQL: usamos um id NOSSO (historico.db).
    let idLocal = sanitizarId(getConfig('instalationId'));
    if (!idLocal) {
        idLocal = gerarId();
        setConfig('instalationId', idLocal);
        console.log(`[PUSH] instalationId ausente no SQL; gerado e guardado localmente: ${idLocal}`);
    }
    cacheInstalationId = idLocal;
    return idLocal;
}

// ── Membros (device_id que podem disparar eventos) ────────────────────────────
function lerMembros() {
    try {
        const a = JSON.parse(fs.readFileSync(MEMBROS_PATH, 'utf8'));
        return Array.isArray(a) ? a.filter(m => m && typeof m.device_id === 'string') : [];
    } catch { return []; }
}

function salvarMembros(arr) {
    fs.mkdirSync(path.dirname(MEMBROS_PATH), { recursive: true });
    fs.writeFileSync(MEMBROS_PATH, JSON.stringify(arr, null, 2));
}

// Registra/atualiza um membro, mais recente primeiro (é o primeiro a ser tentado
// no disparo). Teto de sanidade para não crescer sem limite.
function registrarMembro(deviceId) {
    if (!deviceId || typeof deviceId !== 'string') return;
    const membros = lerMembros().filter(m => m.device_id !== deviceId);
    membros.unshift({ device_id: deviceId, ts: Date.now() });
    salvarMembros(membros.slice(0, 50));
}

function removerMembro(deviceId) {
    salvarMembros(lerMembros().filter(m => m.device_id !== deviceId));
}

// ── HTTP para o serviço unificado ─────────────────────────────────────────────
async function enviar(rota, payload) {
    try {
        const resp = await fetch(`${PUSH_BASE}${rota}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await resp.json().catch(() => ({}));
        return { ok: resp.ok, status: resp.status, json };
    } catch (e) {
        console.error(`[PUSH] Falha em ${rota}:`, e.message);
        return { ok: false, status: 0, json: { erro: e.message } };
    }
}

// ── Proxy do subscribe (navegador → nuvem) ────────────────────────────────────
// O navegador manda só { device_id, token, platform }. O backend injeta o
// instalation_id (que nunca chega ao cliente) + os tópicos, e marca o device
// como membro para poder disparar eventos depois.
async function subscribe(body) {
    const { device_id, token } = body || {};
    const platform = (body && body.platform) || 'web';
    if (!device_id || !token) return { ok: false, status: 400, json: { erro: 'device_id ou token ausente' } };

    const id = await instalationId();
    if (!id) return { ok: false, status: 503, json: { erro: 'instalation_id indisponível' } };

    const payload = {
        device_id,
        token,
        platform,
        topics: ['geral', `instalation-${id}`],
        receber_on: 1,
    };
    // Web recebe os eventos exclusivos GERTEC automaticamente (gertec_on=1).
    if (platform === 'web') payload.gertec_on = 1;

    const r = await enviar('/api/push/subscribe', payload);
    if (r.ok) registrarMembro(device_id);
    return r;
}

// ── Proxy do refresh de token (rotação do FCM) ────────────────────────────────
async function refreshToken(body) {
    const { device_id, token, oldToken } = body || {};
    if (!device_id || !token) return { ok: false, status: 400, json: { erro: 'device_id ou token ausente' } };

    const payload = { device_id, token };
    if (oldToken) payload.oldToken = oldToken;

    const r = await enviar('/api/push/refresh-token', payload);
    if (r.ok) registrarMembro(device_id);
    return r;
}

// ── Disparo de evento ─────────────────────────────────────────────────────────
// Manda { instalation_id, device_id (membro), tag, extra }. O servidor valida,
// sanitiza, renderiza e entrega por tópico. 403 = aquele membro não vale mais →
// descarta e tenta o próximo. 429/outros erros não melhoram trocando de membro.
async function dispararEvento(tag, extra = {}) {
    const id = await instalationId();
    if (!id) return { ok: false, motivo: 'instalation_id indisponível' };

    const membros = lerMembros();
    if (!membros.length) return { ok: false, motivo: 'nenhum dispositivo registrado' };

    for (const m of membros) {
        const resp = await enviar('/api/push/event', {
            instalation_id: id,
            device_id: m.device_id,
            tag,
            extra,
        });
        if (resp.ok) return { ok: true, ...resp.json };
        if (resp.status === 403) {
            console.warn(`[PUSH] Membro ${m.device_id} rejeitado (403). Removendo e tentando o próximo.`);
            removerMembro(m.device_id);
            continue;
        }
        // 429 (rate_limited), 400 (tag), 5xx, etc.: trocar de membro não ajuda.
        return { ok: false, status: resp.status, ...resp.json };
    }
    return { ok: false, motivo: 'sem membro válido' };
}

// Evita flood local: ignora envios repetidos da mesma chave dentro da janela.
// Complementa o rate-limit do servidor — útil sobretudo nas tags que o servidor
// ISENTA do rate-limit (ex.: produto_nao_encontrado), onde leituras repetidas do
// mesmo código não cadastrado disparariam sem parar.
const ultimoEnvio = {};
function emCooldown(chave, ms) {
    const agora = Date.now();
    if (ultimoEnvio[chave] && agora - ultimoEnvio[chave] < ms) return true;
    ultimoEnvio[chave] = agora;
    return false;
}

// Fachada usada pelos produtores (`push.notificar('tag', campos, opts)`). Mantém
// o cooldown local opcional ({ chaveCooldown, cooldownMs }) e delega o resto ao
// serviço unificado, que renderiza e entrega o evento.
function notificar(tag, campos = {}, opts = {}) {
    const { chaveCooldown, cooldownMs = 60000 } = opts;
    if (chaveCooldown && emCooldown(chaveCooldown, cooldownMs)) {
        return Promise.resolve({ ok: false, motivo: 'cooldown' });
    }
    return dispararEvento(tag, campos);
}

// ── Push reverso "limpar" (marcar como lido) ──────────────────────────────────
// Sem `id`, cada PC fecha TODAS as notificações; com `id`, só a daquele item.
async function marcarLido(id) {
    return dispararEvento('limpar', id ? { id: String(id) } : {});
}

// ── Produto muito buscado ─────────────────────────────────────────────────────
// Conta consultas por código (em memória, diário). A cada múltiplo de `limite`
// buscas do mesmo código no dia, dispara `produto_frequente` (com botão Imprimir).
let contagemBuscas = {};
let diaContagem = null; // 'YYYY-M-D' local
function diaLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function contabilizarBusca(codigo, nome, limite, id) {
    limite = parseInt(limite);
    if (!codigo || !limite || limite < 1) return;
    const hoje = diaLocal();
    if (hoje !== diaContagem) {
        // Virou o dia (ou primeira busca após o restart): zera e libera a RAM.
        contagemBuscas = {};
        diaContagem = hoje;
    }
    const n = (contagemBuscas[codigo] = (contagemBuscas[codigo] || 0) + 1);
    if (n % limite === 0) {
        dispararEvento('produto_frequente', { codigo, nome, n, ...(id ? { id: String(id) } : {}) });
    }
}

module.exports = {
    instalationId,
    subscribe,
    refreshToken,
    registrarMembro,
    dispararEvento,
    notificar,
    marcarLido,
    contabilizarBusca,
};
