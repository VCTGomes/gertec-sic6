/* ════════════════════════════════════════════════════════════════════════════
 *  Histórico de leituras — serviço independente (passo 2)
 *  ----------------------------------------------------------------------------
 *  Fonte ÚNICA do histórico consolidado das leituras de todos os terminais.
 *  Antes a leitura/gravação do bdTempLeitura.json estava duplicada dentro de
 *  gertecTC506Server.js e gertecBPServer.js (com risco de corrida no arquivo).
 *  Agora os dois apenas chamam historico.registrar(); este módulo persiste e
 *  AVISA quem estiver ouvindo, sem saber NADA de WebSocket/Socket.IO/HTTP.
 *
 *  É um EventEmitter:
 *    - 'nova'  (leitura)  → uma leitura nova foi registrada
 *    - 'limpo'            → o histórico foi zerado
 *
 *  Consumidores (todos desacoplados deste módulo):
 *    - ponte Socket.IO (front atual)         → server.js
 *    - WebSocket do app (/v1/historico/ws)   → services/appHistoricoWS.js
 *    - HTTP (GET /api/historico)             → server.js
 * ════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const DB_PATH = path.join(__dirname, '..', 'data', 'temp', 'bdTempLeitura.json');
const LIMITE = 200; // teto histórico (mantém o comportamento atual)

class Historico extends EventEmitter {
    // Lista completa, mais novas primeiro (mesma ordem de gravação de hoje).
    lerTudo() {
        try {
            if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        } catch (e) { console.error('[HISTORICO] Erro ao ler:', e.message); }
        return [];
    }

    // Registra uma leitura. Mantém compat: gera `id` se faltar (rastreio de
    // impressão) e mantém os campos já usados pelo front; só ACRESCENTA `ts` ISO.
    // Retorna a própria leitura (com id/ts) — quem chamou precisa do id depois.
    registrar(leitura) {
        if (!leitura.id) leitura.id = crypto.randomUUID();
        if (!leitura.ts) leitura.ts = new Date().toISOString();
        const hist = this.lerTudo();
        hist.unshift(leitura);
        if (hist.length > LIMITE) hist.length = LIMITE;
        this._persistir(hist);
        this.emit('nova', leitura);
        return leitura;
    }

    limpar() {
        this._persistir([]);
        this.emit('limpo');
    }

    _persistir(hist) {
        try {
            fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
            fs.writeFileSync(DB_PATH, JSON.stringify(hist, null, 2));
        } catch (e) {
            console.error('[HISTORICO] Erro ao gravar:', e.message);
        }
    }
}

// Singleton: todos os módulos compartilham a MESMA instância (e os eventos).
module.exports = new Historico();
