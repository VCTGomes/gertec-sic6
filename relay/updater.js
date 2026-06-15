// updater.js — self-deployer do relay (acionado por webhook do GitHub)
require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ─── Configuração ─────────────────────────────────────────────────────────────
const WEBHOOK_PORT   = process.env.WEBHOOK_UPDATER_PORT || 9001;
const WEBHOOK_SECRET = process.env.WEBHOOK_UPDATER_SECRET;
const BRANCH         = process.env.GITHUB_BRANCH || 'main';
const SERVICE_NAME   = process.env.RELAY_SERVICE_NAME || 'gertec-relay'; // Nome no systemctl
const ROOT           = __dirname;
const LOG_FILE       = path.join(ROOT, 'logs', 'updater.log');

// ─── Logger com Rotação ───────────────────────────────────────────────────────
if (!fs.existsSync(path.join(ROOT, 'logs'))) {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > 2 * 1024 * 1024) { // 2MB
            fs.renameSync(LOG_FILE, LOG_FILE + '.old');
        }
    } catch (_) {}
}

// ─── Segurança: Validação HMAC SHA256 ─────────────────────────────────────────
function verifySignature(payload, signature) {
    if (!WEBHOOK_SECRET) return true;
    if (!signature) return false;

    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// ─── Lógica de Verificação e Deploy ──────────────────────────────────────────
async function executarAtualizacao() {
    log('--- Verificando atualizações ---');
    try {
        // 1. Fetch silencioso para comparar versões
        execSync(`git fetch origin ${BRANCH}`, { cwd: ROOT });

        const localSha  = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
        const remoteSha = execSync(`git rev-parse origin/${BRANCH}`, { cwd: ROOT }).toString().trim();

        if (localSha === remoteSha) {
            log(`[git] Versão ${localSha.slice(0, 7)} já é a mais recente. Nada a fazer.`);
            return;
        }

        log(`[git] Nova versão detectada: ${localSha.slice(0, 7)} -> ${remoteSha.slice(0, 7)}`);

        // 2. Aplica as mudanças de forma limpa (certs/ e .env são ignorados e preservados)
        log('[git] Resetando arquivos para o estado do repositório...');
        execSync(`git reset --hard origin/${BRANCH}`, { cwd: ROOT });
        execSync(`git clean -fd`, { cwd: ROOT });

        // 3. Atualiza dependências se necessário
        log('[npm] Atualizando pacotes...');
        execSync('npm install --production --no-audit --no-fund', { cwd: ROOT });

        // 4. Reinicia o serviço principal via systemctl
        log(`[systemctl] Reiniciando serviço: ${SERVICE_NAME}...`);
        execSync(`sudo systemctl restart ${SERVICE_NAME}`);

        log(`[sucesso] Deploy finalizado: versão ${remoteSha.slice(0, 7)} ativa.`);

    } catch (e) {
        log(`[erro] Falha no deploy: ${e.message}`);
    }
}

// ─── Servidor Webhook HTTP ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
        let body = [];

        req.on('data', (chunk) => { body.push(chunk); });
        req.on('end', () => {
            const payload = Buffer.concat(body).toString();
            const signature = req.headers['x-hub-signature-256'];

            if (!verifySignature(payload, signature)) {
                log('[segurança] Assinatura inválida! Requisição bloqueada.');
                res.writeHead(401);
                return res.end('Unauthorized');
            }

            res.writeHead(200);
            res.end('Deploy iniciado');

            log('[github] Webhook validado. Processando...');
            executarAtualizacao();
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(WEBHOOK_PORT, () => {
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`[updater] Ativo na porta ${WEBHOOK_PORT}`);
    log(`[updater] Serviço alvo: ${SERVICE_NAME}`);
    log(`[updater] Segurança: ${WEBHOOK_SECRET ? 'HMAC Ativado' : 'Sem Secret (Atenção!)'}`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
