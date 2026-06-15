require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const admin   = require('firebase-admin');

// ── Configuração via ambiente ──────────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT) || 8787;
const RELAY_SECRET  = process.env.RELAY_SECRET || '';
const CRED_PATH     = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'certs', 'firebase-sa.json');
const TOKENS_PATH   = process.env.TOKENS_PATH || path.join(__dirname, 'data', 'tokens.json');

if (!RELAY_SECRET) {
    console.error('[FATAL] RELAY_SECRET não definido. Configure o .env antes de subir.');
    process.exit(1);
}
if (!fs.existsSync(CRED_PATH)) {
    console.error(`[FATAL] Service account não encontrado em ${CRED_PATH}.`);
    process.exit(1);
}

// ── Firebase Admin ─────────────────────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert(require(CRED_PATH))
});
const messaging = admin.messaging();

// ── Armazenamento simples dos tokens dos dispositivos (arquivo JSON) ────────────
function lerTokens() {
    try {
        return new Set(JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')));
    } catch {
        return new Set();
    }
}
function salvarTokens(set) {
    fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify([...set], null, 2));
}

let tokens = lerTokens();

// ── App ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Exige o segredo compartilhado (Authorization: Bearer <RELAY_SECRET>)
function exigeSegredo(req, res, next) {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== RELAY_SECRET) return res.status(401).json({ erro: 'não autorizado' });
    next();
}

app.get('/health', (req, res) => {
    res.json({ ok: true, dispositivos: tokens.size });
});

// Cada navegador/PWA registra aqui o seu token do FCM
app.post('/register', (req, res) => {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
        return res.status(400).json({ erro: 'token ausente' });
    }
    if (!tokens.has(token)) {
        tokens.add(token);
        salvarTokens(tokens);
    }
    res.json({ ok: true });
});

// Remove um token (ex.: ao desativar notificações no front)
app.post('/unregister', (req, res) => {
    const { token } = req.body || {};
    if (token && tokens.delete(token)) salvarTokens(tokens);
    res.json({ ok: true });
});

// Webhook: dispara a notificação para todos os dispositivos registrados
app.post('/notify', exigeSegredo, async (req, res) => {
    const { title, body, data } = req.body || {};
    if (!title && !body) {
        return res.status(400).json({ erro: 'informe ao menos title ou body' });
    }
    const alvos = [...tokens];
    if (alvos.length === 0) {
        return res.json({ ok: true, enviados: 0, falhas: 0, aviso: 'nenhum dispositivo registrado' });
    }

    try {
        const resp = await messaging.sendEachForMulticast({
            tokens: alvos,
            notification: { title: title || '', body: body || '' },
            data: data && typeof data === 'object' ? data : undefined
        });

        // Limpa tokens que o FCM reportou como inválidos/expirados
        const remover = [];
        resp.responses.forEach((r, i) => {
            if (!r.success) {
                const code = r.error?.code || '';
                if (code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token') {
                    remover.push(alvos[i]);
                }
            }
        });
        if (remover.length) {
            remover.forEach(t => tokens.delete(t));
            salvarTokens(tokens);
        }

        res.json({ ok: true, enviados: resp.successCount, falhas: resp.failureCount, removidos: remover.length });
    } catch (e) {
        console.error('[notify] erro:', e.message);
        res.status(500).json({ erro: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`GERTEC relay ouvindo na porta ${PORT} — ${tokens.size} dispositivo(s) registrado(s)`);
});
