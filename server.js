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

// ── Histórico + impressões (SQLite unificado, serviço desacoplado) ────────────
// Fonte única em services/historico.js (sobre data/gertec.db). As pontes de
// transporte (Socket.IO/HTTP/WS) ficam mais abaixo.
const historico = require('./services/historico');

// Lista de IDs de leituras que já tiveram o preço impresso (consumida pelo front no load)
app.get('/api/impressos', (req, res) => res.json(historico.lerImpressos()));

// ── Impressão de Etiqueta ─────────────────────────────────────────────────────
app.post('/api/imprimir-preco', async (req, res) => {
    const { codigo, id } = req.body;
    if (!codigo) return res.status(400).json({ erro: 'Código ausente' });

    res.json({ ok: true });

    // Marca a leitura individual como impressa (a ponte emite 'leituraImpressa')
    if (id) {
        historico.marcarImpresso(id);
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

// O navegador/PWA registra aqui o token do FCM após ativar as notificações.
// O backend faz proxy (CORS) para o serviço unificado, injetando o instalation_id
// e os tópicos — o navegador nunca vê a credencial da loja.
app.post('/api/push/subscribe', async (req, res) => {
    const r = await push.subscribe(req.body);
    res.status(r.status || (r.ok ? 200 : 500)).json(r.json || { ok: r.ok });
});

// Reenvio fire-and-forget a cada abertura da página: confirma/rotaciona o token
// do device no serviço unificado. Só é chamado quando as notificações já estão
// ativadas (não dispara pedido de permissão).
app.post('/api/push/refresh-token', async (req, res) => {
    const r = await push.refreshToken(req.body);
    res.status(r.status || (r.ok ? 200 : 500)).json(r.json || { ok: r.ok });
});

// Dispara uma notificação de teste para a instalação
app.post('/api/push/test', async (req, res) => {
    res.json(await push.dispararEvento('teste'));
});

// Push reverso: marca tudo como lido (limpa notificações) em todos os PCs
app.post('/api/push/marcar-lido', async (req, res) => {
    res.json(await push.marcarLido());
});

// ── API HTTP SIC Printer (módulo opcional/isolado — celulares via HTTP) ───────
// Mantido em arquivo próprio (routes/sicprinter-http.js) para auditoria fácil.
require('./routes/sicprinter-http')(app);

// ── Pontes de transporte do histórico (Socket.IO + HTTP) ──────────────────────
// O serviço (historico) já foi requerido acima. Aqui só ligamos os transportes;
// o WebSocket do app é montado logo abaixo.

// Ponte Socket.IO: mantém o front atual funcionando sem nenhuma mudança no HTML.
io.on('connection', (socket) => {
    socket.emit('historicoLeituras', historico.lerTudo()); // carga inicial
    socket.on('limparHistorico', () => historico.limpar());
});
historico.on('nova', (leitura) => io.emit('novaLeitura', leitura));
historico.on('impresso', (id) => io.emit('leituraImpressa', id));
historico.on('limpo', () => { io.emit('historicoLeituras', []); io.emit('impressosLimpos'); });

// HTTP: front e (depois) app podem ler o histórico sem depender do WebSocket.
app.get('/api/historico', (req, res) => res.json(historico.lerTudo()));
app.post('/api/historico/limpar', (req, res) => { historico.limpar(); res.json({ ok: true }); });

// WebSocket do app (/v1/historico/ws) — histórico ao vivo, Bearer no handshake.
require('./services/appHistoricoWS')(server);

// ── Serviços TCP ─────────────────────────────────────────────────────────────
require('./services/gertecBPServer')(io);
require('./services/gertecTC506Server')(io);

const PORTA = process.env.PORT || 3006;
server.listen(PORTA, () => {
    console.log(`[GERTEC] Servidor rodando na porta ${PORTA}`);
});