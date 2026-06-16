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

// ── Registro de leituras já impressas ─────────────────────────────────────────
const IMPRESSOS_PATH = path.join(__dirname, 'data', 'temp', 'bdImpressos.json');

function lerImpressos() {
    try {
        if (fs.existsSync(IMPRESSOS_PATH)) return JSON.parse(fs.readFileSync(IMPRESSOS_PATH, 'utf8'));
    } catch (e) { console.error('Erro ao ler impressos:', e.message); }
    return [];
}

function marcarImpresso(id) {
    if (!id) return;
    const ids = lerImpressos();
    if (!ids.includes(id)) {
        ids.push(id);
        fs.mkdirSync(path.dirname(IMPRESSOS_PATH), { recursive: true });
        fs.writeFileSync(IMPRESSOS_PATH, JSON.stringify(ids, null, 2));
    }
}

// Lista de IDs de leituras que já tiveram o preço impresso (consumida pelo front no load)
app.get('/api/impressos', (req, res) => res.json(lerImpressos()));

// Limpa o registro de impressos junto com o histórico
io.on('connection', (socket) => {
    socket.on('limparHistorico', () => {
        fs.mkdirSync(path.dirname(IMPRESSOS_PATH), { recursive: true });
        fs.writeFileSync(IMPRESSOS_PATH, JSON.stringify([], null, 2));
        io.emit('impressosLimpos');
    });
});

// ── Impressão de Etiqueta ─────────────────────────────────────────────────────
app.post('/api/imprimir-preco', async (req, res) => {
    const { codigo, id } = req.body;
    if (!codigo) return res.status(400).json({ erro: 'Código ausente' });

    res.json({ ok: true });

    // Marca a leitura individual como impressa e avisa todos os clientes
    if (id) {
        marcarImpresso(id);
        io.emit('leituraImpressa', id);
        // Push reverso direcionado: fecha SÓ a notificação deste item nos demais
        // PCs, preservando as outras notificações ainda pendentes na fila.
        push.marcarLido(id);
    }

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
    const { token, device_id } = req.body || {};
    if (!push.registrarToken(token, device_id)) {
        return res.status(400).json({ erro: 'token inválido' });
    }
    res.json({ ok: true });
});

// Reenvio fire-and-forget a cada abertura da página: confirma o token do device
// e, se o FCM o rotacionou, atualiza no cadastro. Só é chamado quando as
// notificações já estão ativadas (não dispara pedido de permissão).
app.post('/api/push/refresh-token', (req, res) => {
    const { token, device_id } = req.body || {};
    if (!push.refreshToken(device_id, token)) {
        return res.status(400).json({ erro: 'token ou device_id inválido' });
    }
    res.json({ ok: true });
});

// Dispara uma notificação de teste para todos os dispositivos registrados
app.post('/api/push/test', async (req, res) => {
    res.json(await push.notificar('teste'));
});

// Push reverso: marca tudo como lido (limpa notificações) em todos os PCs
app.post('/api/push/marcar-lido', async (req, res) => {
    res.json(await push.marcarLido());
});

// ── Serviços TCP ─────────────────────────────────────────────────────────────
require('./services/gertecBPServer')(io);
require('./services/gertecTC506Server')(io);

const PORTA = process.env.PORT || 3006;
server.listen(PORTA, () => {
    console.log(`[GERTEC] Servidor rodando na porta ${PORTA}`);
});