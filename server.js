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
const configPath = path.join(__dirname, 'data', 'config.json');

function lerConfig() {
    try {
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {}
    return {
        PORT_BP: parseInt(process.env.PORT_BP) || 6500,
        PORT_TC: parseInt(process.env.PORT_TC) || 16510
    };
}

app.get('/api/config', (req, res) => {
    res.json(lerConfig());
});

app.post('/api/config', (req, res) => {
    try {
        const { PORT_BP, PORT_TC } = req.body;
        const atual = lerConfig();
        const nova = {
            PORT_BP: parseInt(PORT_BP) || atual.PORT_BP,
            PORT_TC: parseInt(PORT_TC) || atual.PORT_TC
        };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(nova, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// ── Serviços TCP ─────────────────────────────────────────────────────────────
require('./services/gertecBPServer')(io);
require('./services/gertecTC506Server')(io);

const PORTA = process.env.PORT || 3006;
server.listen(PORTA, () => {
    console.log(`[GERTEC] Servidor rodando na porta ${PORTA}`);
});