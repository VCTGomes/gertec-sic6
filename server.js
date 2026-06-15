require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gertec.html'));
});

// ── Config ───────────────────────────────────────────────────────────────────
const { lerConfig, configPath } = require('./services/config');

app.get('/api/config', (req, res) => {
    res.json(lerConfig());
});

app.post('/api/config', (req, res) => {
    try {
        const { PORT_BP, PORT_TC, IMPRESSORA_URL, PUSH_BUSCAS_LIMITE } = req.body;
        const atual = lerConfig();
        const nova = {
            ...atual,
            PORT_BP: parseInt(PORT_BP) || atual.PORT_BP,
            PORT_TC: parseInt(PORT_TC) || atual.PORT_TC,
            IMPRESSORA_URL: IMPRESSORA_URL !== undefined ? String(IMPRESSORA_URL).trim() : atual.IMPRESSORA_URL,
            PUSH_BUSCAS_LIMITE: parseInt(PUSH_BUSCAS_LIMITE) || atual.PUSH_BUSCAS_LIMITE
        };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(nova, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// Salva/remove o apelido de um terminal, atrelado ao serial (MAC) do hardware
app.post('/api/apelido', (req, res) => {
    try {
        const { chave, apelido } = req.body;
        if (!chave) return res.status(400).json({ erro: 'Identificador (serial) ausente' });
        const atual = lerConfig();
        const apelidos = { ...(atual.APELIDOS || {}) };
        const nome = apelido !== undefined ? String(apelido).trim() : '';
        if (nome) apelidos[chave] = nome;
        else delete apelidos[chave];
        const nova = { ...atual, APELIDOS: apelidos };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(nova, null, 2));
        res.json({ ok: true, APELIDOS: apelidos });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// ── Impressão de Etiqueta ─────────────────────────────────────────────────────
app.post('/api/imprimir-preco', async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ erro: 'Código ausente' });

    res.json({ ok: true });

    const { IMPRESSORA_URL } = lerConfig();
    if (!IMPRESSORA_URL) {
        console.warn(`[IMPRESSORA] IMPRESSORA_URL não configurada. Ignorando.`);
        return;
    }

    try {
        const url = `${IMPRESSORA_URL}${codigo}`;
        const result = await fetch(url);
        console.log(`[IMPRESSORA] ${codigo} → HTTP ${result.status}`);
    } catch (e) {
        console.error(`[IMPRESSORA] Erro ao imprimir ${codigo}:`, e.message);
    }
});
// ── Notificações Push ─────────────────────────────────────────────────────────
const push = require('./services/push');

// O navegador/PWA registra aqui o token do FCM após ativar as notificações
app.post('/api/push/register', (req, res) => {
    if (!push.registrarToken(req.body && req.body.token)) {
        return res.status(400).json({ erro: 'token inválido' });
    }
    res.json({ ok: true });
});

// Dispara uma notificação de teste para todos os dispositivos registrados
app.post('/api/push/test', async (req, res) => {
    res.json(await push.notificar('GERTEC — Teste', 'Notificações funcionando! 🎉'));
});

// ── Serviços TCP ─────────────────────────────────────────────────────────────
require('./services/gertecBPServer')(io);
require('./services/gertecTC506Server')(io);

const PORTA = process.env.PORT || 3006;
server.listen(PORTA, () => {
    console.log(`[GERTEC] Servidor rodando na porta ${PORTA}`);
});