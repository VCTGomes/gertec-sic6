const fs   = require('fs');
const path = require('path');

// Tokens dos dispositivos que ativaram notificação (um por navegador/PWA)
const KEYS_PATH    = path.join(__dirname, '..', 'data', 'push', 'keys.json');
const RELAY_URL    = process.env.PUSH_RELAY_URL || 'https://webhook-tc.vctgomes.com/notify';
const RELAY_SECRET = process.env.RELAY_SECRET || '';

function lerTokens() {
    try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); }
    catch { return []; }
}

function salvarTokens(arr) {
    fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
    fs.writeFileSync(KEYS_PATH, JSON.stringify(arr, null, 2));
}

function registrarToken(token) {
    if (!token || typeof token !== 'string') return false;
    const tokens = lerTokens();
    if (!tokens.includes(token)) {
        tokens.push(token);
        salvarTokens(tokens);
        console.log(`[PUSH] Novo dispositivo registrado (${tokens.length} no total).`);
    }
    return true;
}

function removerTokens(invalidos) {
    if (!Array.isArray(invalidos) || !invalidos.length) return;
    const restantes = lerTokens().filter(t => !invalidos.includes(t));
    salvarTokens(restantes);
    console.log(`[PUSH] ${invalidos.length} token(s) inválido(s) removido(s).`);
}

// Evita flood: ignora envios repetidos da mesma chave dentro da janela
const ultimoEnvio = {};
function emCooldown(chave, ms) {
    const agora = Date.now();
    if (ultimoEnvio[chave] && agora - ultimoEnvio[chave] < ms) return true;
    ultimoEnvio[chave] = agora;
    return false;
}

/**
 * Encaminha uma notificação para o relay, que distribui via FCM.
 * @param {string} title
 * @param {string} body
 * @param {object} [opts] { data, chaveCooldown, cooldownMs }
 */
async function notificar(title, body, opts = {}) {
    const { data, chaveCooldown, cooldownMs = 60000 } = opts;

    const tokens = lerTokens();
    if (!tokens.length) return { ok: false, motivo: 'nenhum dispositivo registrado' };
    if (chaveCooldown && emCooldown(chaveCooldown, cooldownMs)) {
        return { ok: false, motivo: 'cooldown' };
    }

    try {
        const resp = await fetch(RELAY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(RELAY_SECRET ? { Authorization: `Bearer ${RELAY_SECRET}` } : {})
            },
            body: JSON.stringify({ tokens, title, body, data })
        });
        const json = await resp.json().catch(() => ({}));
        if (Array.isArray(json.invalidos)) removerTokens(json.invalidos);
        return { ok: resp.ok, ...json };
    } catch (e) {
        console.error('[PUSH] Falha ao notificar:', e.message);
        return { ok: false, erro: e.message };
    }
}

// Push reverso: dispara um data-only `acao=limpar` para todos os dispositivos,
// que então fecham suas notificações abertas ("marcar como lido" em todos os PCs).
// Pequeno cooldown evita rajadas (ex.: vários PCs abrindo o painel ao mesmo tempo).
async function marcarLido() {
    return notificar('GERTEC', '', {
        data: { acao: 'limpar' },
        chaveCooldown: 'limpar',
        cooldownMs: 1500
    });
}

// Conta consultas por código (em memória, reinicia junto com o serviço).
// A cada múltiplo de `limite` buscas do mesmo código, dispara uma notificação
// com botão "Imprimir preço".
const contagemBuscas = {};
function contabilizarBusca(codigo, nome, limite, id) {
    limite = parseInt(limite);
    if (!codigo || !limite || limite < 1) return;
    const n = (contagemBuscas[codigo] = (contagemBuscas[codigo] || 0) + 1);
    if (n % limite === 0) {
        notificar('Produto muito buscado', `${nome} já foi consultado ${n}x`, {
            // `id` = leitura que cruzou o limite; o SW repassa pra registrar a impressão
            data: { codigo, nome, acao: 'imprimir', ...(id ? { id } : {}) },
            chaveCooldown: `bm:${codigo}`,
            cooldownMs: 60000
        });
    }
}

module.exports = { registrarToken, removerTokens, notificar, marcarLido, contabilizarBusca, lerTokens };
