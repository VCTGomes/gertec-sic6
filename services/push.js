const fs   = require('fs');
const path = require('path');

// Tokens dos dispositivos que ativaram notificação (um por navegador/PWA)
const KEYS_PATH    = path.join(__dirname, '..', 'data', 'push', 'keys.json');
const RELAY_URL    = process.env.PUSH_RELAY_URL || 'https://webhook-tc.vctgomes.com/notify';
const RELAY_SECRET = process.env.RELAY_SECRET || '';

// Cada registro é { device_id, token }. Formato legado (array de strings) é
// normalizado na leitura para manter compatibilidade com keys.json antigos.
function lerRegistros() {
    let dados;
    try { dados = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); }
    catch { return []; }
    if (!Array.isArray(dados)) return [];
    return dados.map(r =>
        typeof r === 'string' ? { device_id: null, token: r } : r
    ).filter(r => r && typeof r.token === 'string' && r.token);
}

function salvarRegistros(arr) {
    fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
    fs.writeFileSync(KEYS_PATH, JSON.stringify(arr, null, 2));
}

// Lista de tokens (strings) para envio ao relay.
function lerTokens() {
    return lerRegistros().map(r => r.token);
}

// Associa token a um device_id. Se o device já existe, atualiza o token;
// caso contrário, cria o registro. Sem device_id, faz dedupe pelo token (legado).
function registrarToken(token, deviceId) {
    if (!token || typeof token !== 'string') return false;
    const registros = lerRegistros();

    if (deviceId && typeof deviceId === 'string') {
        const reg = registros.find(r => r.device_id === deviceId);
        if (reg) {
            if (reg.token !== token) {
                reg.token = token;
                salvarRegistros(registros);
                console.log(`[PUSH] Token atualizado para device ${deviceId}.`);
            }
        } else {
            // Adota registro legado (device_id null) de mesmo token p/ evitar duplicar.
            const legado = registros.find(r => !r.device_id && r.token === token);
            if (legado) {
                legado.device_id = deviceId;
                salvarRegistros(registros);
                console.log(`[PUSH] Device ${deviceId} associado a token existente.`);
            } else {
                registros.push({ device_id: deviceId, token });
                salvarRegistros(registros);
                console.log(`[PUSH] Novo dispositivo registrado (${registros.length} no total).`);
            }
        }
        return true;
    }

    if (!registros.some(r => r.token === token)) {
        registros.push({ device_id: null, token });
        salvarRegistros(registros);
        console.log(`[PUSH] Novo dispositivo registrado (${registros.length} no total).`);
    }
    return true;
}

// Reenvio fire-and-forget a cada abertura da página: confirma/atualiza o token
// do device. Como os tokens do FCM rotacionam, se divergir do cadastrado o novo
// prevalece. Se o device ainda não existe, registra.
function refreshToken(deviceId, token) {
    if (!deviceId || typeof deviceId !== 'string') return false;
    if (!token || typeof token !== 'string') return false;
    const registros = lerRegistros();
    const reg = registros.find(r => r.device_id === deviceId);
    if (!reg) {
        // Adota registro legado (device_id null) de mesmo token p/ evitar duplicar.
        const legado = registros.find(r => !r.device_id && r.token === token);
        if (legado) {
            legado.device_id = deviceId;
            salvarRegistros(registros);
            console.log(`[PUSH] Device ${deviceId} associado a token existente via refresh.`);
        } else {
            registros.push({ device_id: deviceId, token });
            salvarRegistros(registros);
            console.log(`[PUSH] Device ${deviceId} registrado via refresh (${registros.length} no total).`);
        }
    } else if (reg.token !== token) {
        reg.token = token;
        salvarRegistros(registros);
        console.log(`[PUSH] Token rotacionado para device ${deviceId}.`);
    }
    return true;
}

function removerTokens(invalidos) {
    if (!Array.isArray(invalidos) || !invalidos.length) return;
    const restantes = lerRegistros().filter(r => !invalidos.includes(r.token));
    salvarRegistros(restantes);
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
 * Encaminha uma notificação para o relay, que valida/sanitiza e distribui via FCM.
 * O app só informa o `evento` + campos estruturados — a redação exibida é montada
 * no `sw.js` (cliente). Assim ninguém manda texto arbitrário (evita mau uso).
 * @param {string} evento  chave do catálogo (ex.: 'leitor_desconectado')
 * @param {object} [campos] campos do evento (ex.: { nome, ip, motivo })
 * @param {object} [opts]  { chaveCooldown, cooldownMs }
 */
async function notificar(evento, campos = {}, opts = {}) {
    const { chaveCooldown, cooldownMs = 60000 } = opts;

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
            body: JSON.stringify({ tokens, evento, ...campos })
        });
        const json = await resp.json().catch(() => ({}));
        if (Array.isArray(json.invalidos)) removerTokens(json.invalidos);
        return { ok: resp.ok, ...json };
    } catch (e) {
        console.error('[PUSH] Falha ao notificar:', e.message);
        return { ok: false, erro: e.message };
    }
}

// Push reverso: dispara um data-only `evento=limpar` para todos os dispositivos.
// Sem `id`, cada PC fecha TODAS as suas notificações ("marcar tudo como lido").
// Com `id`, fecha só a notificação daquele item (ex.: ao imprimir um da fila).
// Pequeno cooldown evita rajadas (ex.: vários PCs abrindo o painel ao mesmo tempo).
async function marcarLido(id) {
    const campos = id ? { id: String(id) } : {};
    return notificar('limpar', campos, {
        chaveCooldown: id ? `limpar:${id}` : 'limpar',
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
        // `id` = leitura que cruzou o limite; o SW repassa pra registrar a impressão.
        notificar('produto_frequente', { codigo, nome, n, ...(id ? { id } : {}) }, {
            chaveCooldown: `bm:${codigo}`,
            cooldownMs: 60000
        });
    }
}

module.exports = { registrarToken, refreshToken, removerTokens, notificar, marcarLido, contabilizarBusca, lerTokens };
