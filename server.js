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
        const { PORT_BP, PORT_TC, IMPRESSORA_URL } = req.body;
        const atual = lerConfig();
        const nova = {
            PORT_BP: parseInt(PORT_BP) || atual.PORT_BP,
            PORT_TC: parseInt(PORT_TC) || atual.PORT_TC,
            IMPRESSORA_URL: IMPRESSORA_URL !== undefined ? String(IMPRESSORA_URL).trim() : atual.IMPRESSORA_URL
        };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(nova, null, 2));
        res.json({ ok: true });
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
// ── Serviços TCP ─────────────────────────────────────────────────────────────
require('./services/gertecBPServer')(io);
require('./services/gertecTC506Server')(io);

const PORTA = process.env.PORT || 3006;
server.listen(PORTA, () => {
    console.log(`[GERTEC] Servidor rodando na porta ${PORTA}`);
});