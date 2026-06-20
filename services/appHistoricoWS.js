/* ════════════════════════════════════════════════════════════════════════════
 *  WebSocket do app — histórico ao vivo (/v1/historico/ws)  [spec seção 10]
 *  ----------------------------------------------------------------------------
 *  WebSocket CRU (lib `ws`, não Socket.IO) para o app SIC Printer consumir o
 *  histórico consolidado dos leitores em tempo real. Só leitura (servidor→app).
 *
 *  - Mesmo host/porta da API (wss:// quando atrás do HTTPS do IIS).
 *  - Auth no handshake: Authorization: Bearer <token de leitura ou escrita>.
 *  - Ao conectar: envia { tipo:'snapshot', itens:[...] } (mais novas primeiro).
 *  - A cada leitura nova: { tipo:'leitura', item:{...} }.
 *  - Ping/pong: responde { tipo:'pong' } a { tipo:'ping' } e usa ping de
 *    protocolo (heartbeat) para derrubar conexões mortas.
 *
 *  Fonte dos dados: services/historico.js (desacoplado — este módulo só ouve).
 * ════════════════════════════════════════════════════════════════════════════ */

const { WebSocketServer } = require('ws');
const historico = require('./historico');
const { lerConfig } = require('./config');
const { extrairBearer, verificarToken } = require('./sicprinterStore');

const ROTA = '/v1/historico/ws';
const SNAPSHOT_MAX = 300;       // teto do snapshot inicial (spec: 100–300)
const HEARTBEAT_MS = 30000;     // ping de protocolo para detectar sockets mortos

// Converte a leitura interna (formato do bdTempLeitura.json) no item da spec.
function paraItemApp(l) {
    const { APELIDOS = {} } = lerConfig();
    const terminalStr = String(l.terminal || '');
    const ipMatch = terminalStr.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)/);
    const terminalIp = ipMatch ? ipMatch[1] : '';
    const nomeBase = terminalStr.replace(/\s*\([^)]*\)\s*$/, '').trim(); // tira " (ip)"
    const apelido = l.serial && APELIDOS[l.serial];
    const erro = l.status === 'erro';
    const preco = String(l.preco || '').replace(/^R\$\s*/i, '').trim();

    return {
        id: l.id || null,            // permite ao app correlacionar atualizações (ex.: impresso)
        ts: l.ts || l.hora || null,
        terminal: apelido || nomeBase || terminalStr,
        terminalIp,
        codigo: l.codigo || '',
        descricao: erro ? '' : (l.nome || ''),
        preco: preco === '-' ? '' : preco,
        acao: erro ? 'nao_encontrado' : (l.impresso ? 'impresso' : 'consultado'),
    };
}

function enviar(ws, obj) {
    if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket caindo */ }
    }
}

function enviarSnapshot(ws) {
    const itens = historico.lerTudo().slice(0, SNAPSHOT_MAX).map(paraItemApp);
    enviar(ws, { tipo: 'snapshot', itens });
}

module.exports = function (server) {
    const wss = new WebSocketServer({ noServer: true });

    // Handshake: só nossa rota; valida Bearer antes de aceitar o upgrade.
    server.on('upgrade', (req, socket, head) => {
        let pathname;
        try { pathname = new URL(req.url, 'http://localhost').pathname; }
        catch (e) { return; }
        if (pathname !== ROTA) return; // outras rotas (ex.: Socket.IO) seguem o fluxo normal

        const v = verificarToken(extrairBearer(req.headers['authorization']));
        if (!v.ok) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        // Mensagens do app: só tratamos ping de aplicação (resto é ignorado).
        ws.on('message', (raw) => {
            let m;
            try { m = JSON.parse(raw.toString()); } catch (e) { return; }
            if (m && m.tipo === 'ping') enviar(ws, { tipo: 'pong' });
        });

        enviarSnapshot(ws); // carga inicial logo após conectar
    });

    // Heartbeat de protocolo: derruba quem não responde ao ping.
    const hb = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            try { ws.ping(); } catch (e) { /* ignore */ }
        });
    }, HEARTBEAT_MS);
    wss.on('close', () => clearInterval(hb));

    // Assina o serviço de histórico (uma vez) e repassa a todos os apps conectados.
    historico.on('nova', (leitura) => {
        const item = paraItemApp(leitura);
        wss.clients.forEach((ws) => enviar(ws, { tipo: 'leitura', item }));
    });
    // Uma leitura foi marcada como impressa → atualiza ao vivo (app acha pelo id).
    historico.on('impresso', (id) => {
        const msg = { tipo: 'impresso', id, ts: new Date().toISOString() };
        wss.clients.forEach((ws) => enviar(ws, msg));
    });
    historico.on('limpo', () => {
        wss.clients.forEach((ws) => enviar(ws, { tipo: 'snapshot', itens: [] }));
    });

    console.log(`[HISTORICO-WS] WebSocket do app em ${ROTA}`);
    return wss;
};
