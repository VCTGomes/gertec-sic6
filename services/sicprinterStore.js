/* ════════════════════════════════════════════════════════════════════════════
 *  SIC Printer — store de tokens + verificação (compartilhado)
 *  ----------------------------------------------------------------------------
 *  Fonte única do estado/segredos da API HTTP do app (data/sicprinter.json) e
 *  da verificação de Bearer token em tempo constante. Usado tanto pela API REST
 *  (routes/sicprinter-http.js) quanto pelo WebSocket do app (appHistoricoWS.js),
 *  para não duplicar a comparação de token em dois lugares.
 * ════════════════════════════════════════════════════════════════════════════ */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'sicprinter.json');

function lerStore() {
    try {
        if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch (e) { console.error('[SICPRINTER] Erro ao ler store:', e.message); }
    return { habilitado: false, tokenLeitura: '', tokenEscrita: '', criadoEm: null };
}

function salvarStore(s) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
}

function novoToken() {
    return crypto.randomBytes(32).toString('base64url');
}

// Comparação em tempo constante (evita timing attack), segura quanto a tamanho.
function tokensIguais(a, b) {
    if (!a || !b) return false;
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// Extrai o token de um header Authorization: Bearer <token>
function extrairBearer(authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim());
    return m ? m[1].trim() : null;
}

// Resultado da verificação: { ok, escopo, motivo }
//   escopo: 'escrita' | 'leitura' | null
//   motivo (quando !ok): 'desabilitado' | 'ausente' | 'invalido'
function verificarToken(token) {
    const st = lerStore();
    if (!st.habilitado) return { ok: false, escopo: null, motivo: 'desabilitado' };
    if (!token)         return { ok: false, escopo: null, motivo: 'ausente' };
    if (tokensIguais(token, st.tokenEscrita)) return { ok: true, escopo: 'escrita' };
    if (tokensIguais(token, st.tokenLeitura)) return { ok: true, escopo: 'leitura' };
    return { ok: false, escopo: null, motivo: 'invalido' };
}

module.exports = {
    STORE_PATH,
    lerStore,
    salvarStore,
    novoToken,
    tokensIguais,
    extrairBearer,
    verificarToken,
};
