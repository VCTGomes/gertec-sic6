require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const admin   = require('firebase-admin');

// ── Configuração via ambiente ──────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT) || 8787;
const RELAY_SECRET = process.env.RELAY_SECRET || ''; // vazio = /notify aberto (não recomendado)
const CRED_PATH    = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'certs', 'firebase-sa.json');

if (!fs.existsSync(CRED_PATH)) {
    console.error(`[FATAL] Service account não encontrado em ${CRED_PATH}.`);
    process.exit(1);
}

// ── Firebase Admin ─────────────────────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert(require(CRED_PATH))
});
const messaging = admin.messaging();

// ── App ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Exige o segredo compartilhado (Authorization: Bearer <RELAY_SECRET>), se configurado
function exigeSegredo(req, res, next) {
    if (!RELAY_SECRET) return next();
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== RELAY_SECRET) return res.status(401).json({ erro: 'não autorizado' });
    next();
}

app.get('/health', (req, res) => {
    res.json({ ok: true, protegido: Boolean(RELAY_SECRET) });
});

// Divide um array em lotes de tamanho n (FCM aceita no máx. 500 tokens por chamada)
function emLotes(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

// Webhook stateless: o caller (app GERTEC) envia os tokens-alvo no corpo.
// Body: { tokens: string | string[], title, body, data }
app.post('/notify', exigeSegredo, async (req, res) => {
    const { tokens, title, body, data } = req.body || {};

    const alvos = (Array.isArray(tokens) ? tokens : [tokens])
        .filter(t => typeof t === 'string' && t.length);

    if (alvos.length === 0) return res.status(400).json({ erro: 'informe ao menos um token' });
    if (!title && !body)    return res.status(400).json({ erro: 'informe ao menos title ou body' });

    try {
        let enviados = 0, falhas = 0;
        const invalidos = [];

        // Mensagem data-only: o service worker do cliente é quem renderiza a
        // notificação (permite botões de ação e evita duplicidade no Chrome).
        // Todos os valores de `data` no FCM precisam ser string.
        const dataMsg = { title: String(title || ''), body: String(body || '') };
        if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
                if (v !== undefined && v !== null) dataMsg[k] = String(v);
            }
        }

        for (const lote of emLotes(alvos, 500)) {
            const resp = await messaging.sendEachForMulticast({
                tokens: lote,
                data: dataMsg,
                webpush: { headers: { Urgency: 'high' } }
            });
            enviados += resp.successCount;
            falhas   += resp.failureCount;

            // Reporta de volta quais tokens o FCM considera inválidos/expirados,
            // para o caller removê-los do seu próprio armazenamento.
            resp.responses.forEach((r, i) => {
                if (!r.success) {
                    const code = r.error?.code || '';
                    if (code === 'messaging/registration-token-not-registered' ||
                        code === 'messaging/invalid-registration-token') {
                        invalidos.push(lote[i]);
                    }
                }
            });
        }

        res.json({ ok: true, enviados, falhas, invalidos });
    } catch (e) {
        console.error('[notify] erro:', e.message);
        res.status(500).json({ erro: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`GERTEC relay ouvindo na porta ${PORT} — /notify ${RELAY_SECRET ? 'protegido' : 'ABERTO (sem RELAY_SECRET)'}`);
});
