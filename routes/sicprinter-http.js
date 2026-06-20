/* ════════════════════════════════════════════════════════════════════════════
 *  SIC PRINTER — API HTTP (componente servidor)
 *  ----------------------------------------------------------------------------
 *  Módulo OPCIONAL e ISOLADO. Expõe, sob /v1/*, uma API que o app SIC Printer
 *  (Flutter) consome no lugar de conectar direto no SQL Server. A credencial do
 *  banco NUNCA sai daqui — o aparelho guarda apenas baseUrl + token.
 *
 *  Tudo que este arquivo faz é LER as mesmas tabelas que o ERP já usa
 *  (TABEST1, TABARQUIVOS, TABSICINI, TABUSER) e gravar config do próprio app
 *  em TABARQUIVOS. Não coleta, não envia e não armazena nada do usuário em
 *  servidor externo. Mantido em arquivo próprio justamente para auditoria fácil.
 *
 *  Segurança:
 *   - Bearer token (par leitura/escrita), comparado em tempo constante.
 *   - Token nunca é logado.
 *   - Toda query é parametrizada (prepared statements).
 *   - Desligado por padrão: só responde /v1/* quando habilitado no painel.
 *
 *  Contrato completo: ver spec "API HTTP do SIC Printer".
 * ════════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const QRCode = require('qrcode');
const { query, queryOne } = require('../database');
const historico = require('../services/historico'); // registra leitura/impressão do app
// Store/tokens compartilhados com o WebSocket do app (sem duplicar a comparação).
const { lerStore, salvarStore, novoToken, tokensIguais } = require('../services/sicprinterStore');

const VERSAO = '1.0.0';

// Nome da empresa vem SEMPRE do SQL (TABSICINI [Geral].Empresa) — não é digitado.
async function lerEmpresa() {
    try {
        const row = await queryOne(
            `SELECT TOP 1 VALOR FROM TABSICINI WHERE SECAO = 'Geral' AND IDENT = 'Empresa'`);
        return row && row.VALOR != null ? String(row.VALOR).trim() : '';
    } catch (e) {
        return '';
    }
}

// ── Helpers de resposta de erro (formato comum da spec) ───────────────────────
function erro(res, http, codigo, mensagem) {
    return res.status(http).json({ erro: mensagem, codigo });
}

// ── Formatação de campos (fiel ao parsing do app) ─────────────────────────────
function precoBR(money) {
    // money do mssql vem como number; app espera string BR "14,99" (sem "R$").
    if (money == null) return null;
    return parseFloat(money).toFixed(2).replace('.', ',');
}

function fotoBase64(img) {
    // coluna image → Buffer; base64 puro (sem prefixo data:/0x). null se vazio.
    if (!img || !img.length) return null;
    return Buffer.from(img).toString('base64');
}

module.exports = function (app) {

    // ════════════════════════════════════════════════════════════════════════
    //  MIDDLEWARE DE AUTENTICAÇÃO (Bearer)
    // ════════════════════════════════════════════════════════════════════════
    function extrairToken(req) {
        const h = req.headers['authorization'] || '';
        const m = /^Bearer\s+(.+)$/i.exec(h.trim());
        return m ? m[1].trim() : null;
    }

    // Exige token de LEITURA (vale o de leitura OU o de escrita).
    function exigeLeitura(req, res, next) {
        const st = lerStore();
        if (!st.habilitado) return erro(res, 404, 'DESABILITADO', 'API SIC Printer desabilitada');
        const tk = extrairToken(req);
        if (!tk) return erro(res, 401, 'TOKEN_AUSENTE', 'Token ausente');
        if (tokensIguais(tk, st.tokenLeitura) || tokensIguais(tk, st.tokenEscrita)) {
            req._sic = st;
            return next();
        }
        return erro(res, 401, 'TOKEN_INVALIDO', 'Token inválido');
    }

    // Exige token de ESCRITA. Token de leitura válido → 403 (não 401).
    function exigeEscrita(req, res, next) {
        const st = lerStore();
        if (!st.habilitado) return erro(res, 404, 'DESABILITADO', 'API SIC Printer desabilitada');
        const tk = extrairToken(req);
        if (!tk) return erro(res, 401, 'TOKEN_AUSENTE', 'Token ausente');
        if (tokensIguais(tk, st.tokenEscrita)) { req._sic = st; return next(); }
        if (tokensIguais(tk, st.tokenLeitura)) {
            return erro(res, 403, 'SEM_ESCRITA', 'Token de leitura não pode escrever');
        }
        return erro(res, 401, 'TOKEN_INVALIDO', 'Token inválido');
    }

    // Wrapper async: traduz erro de conexão SQL em 503 e erro genérico em 500.
    function rota(handler) {
        return async (req, res) => {
            try {
                await handler(req, res);
            } catch (e) {
                const conexao = /closed|terminat|not connected|connection|ECONN|ESOCKET|ETIMEOUT|ELOGIN|ENOTOPEN/i
                    .test(e.message || '');
                console.error(`[SICPRINTER] ${req.method} ${req.path} → ${e.message}`);
                if (conexao) return erro(res, 503, 'BANCO_INDISPONIVEL', 'Banco de dados indisponível');
                return erro(res, 500, 'ERRO_INTERNO', 'Erro interno');
            }
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  4.1  HEALTH (sem auth) — reflete a saúde REAL da conexão com o SQL
    // ════════════════════════════════════════════════════════════════════════
    app.get('/v1/health', async (req, res) => {
        try {
            await query('SELECT 1 AS ok');
            res.json({ ok: true, empresa: await lerEmpresa(), versao: VERSAO });
        } catch (e) {
            res.status(503).json({ ok: false, empresa: '', versao: VERSAO });
        }
    });

    // ════════════════════════════════════════════════════════════════════════
    //  4.2  PRODUTO POR CÓDIGO (detalhe + foto)
    //  Mesma resolução de barcode que o resto do GERTEC: codigo → cean → s/ zeros
    // ════════════════════════════════════════════════════════════════════════
    const SELECT_PRODUTO = `
        SELECT TOP 1
            LTRIM(RTRIM(CAST(codigo  AS nvarchar(30))))  AS codigo,
            LTRIM(RTRIM(CAST(produto AS nvarchar(300)))) AS descricao,
            precovenda                                   AS preco,
            LTRIM(RTRIM(CAST(unidade AS nvarchar(30))))  AS unidade,
            CONVERT(varchar(10), ultreaj, 23)            AS ultreaj,
            quantidade                                   AS quantidade,
            foto                                         AS foto
        FROM tabest1
        WHERE %CAMPO% = @codigo`;

    async function buscarProduto(codigoBruto) {
        const codigo = String(codigoBruto || '').trim();
        if (!codigo) return null;

        let row = await queryOne(SELECT_PRODUTO.replace('%CAMPO%', 'CAST(codigo AS nvarchar(30))'), { codigo });
        if (!row) row = await queryOne(SELECT_PRODUTO.replace('%CAMPO%', 'CAST(cean AS nvarchar(30))'), { codigo });
        if (!row) {
            const semZero = codigo.replace(/^0+/, '');
            if (semZero && semZero !== codigo) {
                row = await queryOne(SELECT_PRODUTO.replace('%CAMPO%', 'CAST(codigo AS nvarchar(30))'), { codigo: semZero });
            }
        }
        if (!row) return null;
        return {
            codigo:     row.codigo || codigo,
            descricao:  row.descricao || '',
            preco:      precoBR(row.preco),
            unidade:    row.unidade || '',
            ultreaj:    row.ultreaj || null,
            quantidade: row.quantidade != null ? row.quantidade : null,
            fotoBase64: fotoBase64(row.foto),
        };
    }

    app.get('/v1/produtos/:codigo', exigeLeitura, rota(async (req, res) => {
        const prod = await buscarProduto(req.params.codigo);
        if (!prod) return erro(res, 404, 'NAO_ENCONTRADO', 'Produto não encontrado');
        res.json(prod);
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  4.3  BUSCA PAGINADA (lista leve, sem foto)
    //  Insensível a maiúsculas/acentos via COLLATE Latin1_General_CI_AI.
    // ════════════════════════════════════════════════════════════════════════
    app.get('/v1/produtos', exigeLeitura, rota(async (req, res) => {
        let limite = parseInt(req.query.limite, 10);
        let offset = parseInt(req.query.offset, 10);
        if (!Number.isFinite(limite) || limite <= 0) limite = 50;
        if (limite > 200) limite = 200;                       // teto de sanidade
        if (!Number.isFinite(offset) || offset < 0) {
            if (req.query.offset !== undefined) return erro(res, 400, 'OFFSET_INVALIDO', 'offset inválido');
            offset = 0;
        }

        const termo = String(req.query.busca || '').trim();
        // escapa curingas do LIKE no termo do usuário (usa ESCAPE '\')
        const escapado = termo.replace(/[\\%_\[]/g, c => '\\' + c);
        const like = `%${escapado}%`;
        const since = String(req.query.since || '').trim(); // sync incremental opcional

        const filtros = [];
        const params = { limite, offset };
        if (termo) {
            filtros.push(`(CAST(codigo AS nvarchar(40)) COLLATE Latin1_General_CI_AI LIKE @busca ESCAPE '\\'
                       OR produto COLLATE Latin1_General_CI_AI LIKE @busca ESCAPE '\\')`);
            params.busca = like;
        }
        if (since) { filtros.push(`ultreaj >= @since`); params.since = since; }
        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

        const itens = await query(`
            SELECT
                LTRIM(RTRIM(CAST(codigo  AS nvarchar(40))))  AS codigo,
                LTRIM(RTRIM(CAST(produto AS nvarchar(300)))) AS descricao,
                precovenda                                   AS preco,
                LTRIM(RTRIM(CAST(unidade AS nvarchar(30))))  AS unidade,
                CONVERT(varchar(10), ultreaj, 23)            AS ultreaj,
                quantidade                                   AS quantidade,
                foto                                         AS foto
            FROM tabest1
            ${where}
            ORDER BY produto
            OFFSET @offset ROWS FETCH NEXT @limite ROWS ONLY
        `, params);

        res.json({
            itens: itens.map(r => ({
                codigo:     r.codigo || '',
                descricao:  r.descricao || '',
                preco:      precoBR(r.preco),
                unidade:    r.unidade || '',
                ultreaj:    r.ultreaj || null,
                quantidade: r.quantidade != null ? r.quantidade : null,
                fotoBase64: fotoBase64(r.foto),   // ícone da lista — o app lê daqui
            })),
            limite, offset,
        });
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  4.5  LER TEXTO de TABARQUIVOS (pull de config do app)
    // ════════════════════════════════════════════════════════════════════════
    app.get('/v1/tabarquivos/:ident', exigeLeitura, rota(async (req, res) => {
        const ident = String(req.params.ident || '').trim();
        const row = await queryOne(
            `SELECT TOP 1 TEXTO FROM TABARQUIVOS WHERE IDENT = @ident`, { ident });
        if (!row) return erro(res, 404, 'NAO_ENCONTRADO', 'Ident não encontrado');
        res.json({ ident, texto: row.TEXTO != null ? String(row.TEXTO) : null });
    }));

    // ── 4.6  GRAVAR TEXTO (upsert) — ESCRITA ──────────────────────────────────
    app.put('/v1/tabarquivos/:ident', exigeEscrita, rota(async (req, res) => {
        const ident = String(req.params.ident || '').trim();
        const texto = req.body && req.body.texto;
        if (typeof texto !== 'string') return erro(res, 400, 'TEXTO_INVALIDO', 'Campo texto ausente');

        await query(`
            IF EXISTS (SELECT 1 FROM TABARQUIVOS WHERE IDENT = @ident)
                UPDATE TABARQUIVOS SET TEXTO = @texto WHERE IDENT = @ident
            ELSE
                INSERT INTO TABARQUIVOS (IDENT, TEXTO) VALUES (@ident, @texto)
        `, { ident, texto });
        res.json({ ok: true });
    }));

    // ── 4.4  IMAGEM de TABARQUIVOS (binário + ETag) ───────────────────────────
    app.get('/v1/tabarquivos/:ident/imagem', exigeLeitura, rota(async (req, res) => {
        const ident = String(req.params.ident || '').trim();
        const row = await queryOne(
            `SELECT IMAGEM FROM TABARQUIVOS WHERE IDENT = @ident`, { ident });
        if (!row || !row.IMAGEM || !row.IMAGEM.length) {
            return erro(res, 404, 'NAO_ENCONTRADO', 'Imagem não encontrada');
        }
        const buf = Buffer.from(row.IMAGEM);
        const etag = '"' + crypto.createHash('md5').update(buf).digest('hex') + '"';
        if (req.headers['if-none-match'] === etag) return res.status(304).end();
        res.set('ETag', etag);
        res.set('Cache-Control', 'no-cache');
        res.type('image/png');               // tipo real desconhecido; logo é PNG na prática
        res.send(buf);
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  4.7  PARÂMETRO do SIC (TABSICINI)
    //  Chave composta SECAO+IDENT; aceita ?secao= opcional para desambiguar.
    // ════════════════════════════════════════════════════════════════════════
    app.get('/v1/sicini/:ident', exigeLeitura, rota(async (req, res) => {
        const ident = String(req.params.ident || '').trim();
        const secao = req.query.secao !== undefined ? String(req.query.secao).trim() : null;
        const row = secao != null
            ? await queryOne(`SELECT TOP 1 VALOR FROM TABSICINI WHERE IDENT = @ident AND SECAO = @secao`, { ident, secao })
            : await queryOne(`SELECT TOP 1 VALOR FROM TABSICINI WHERE IDENT = @ident`, { ident });
        if (!row) return erro(res, 404, 'NAO_ENCONTRADO', 'Parâmetro não encontrado');
        res.json({ ident, valor: row.VALOR != null ? String(row.VALOR).trim() : null });
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  4.10 REGISTRAR IMPRESSÃO DO CELULAR (app imprime sozinho; só nos avisa)
    //  ANEXA a impressão à leitura mais recente do mesmo código (não cria uma
    //  "consulta do app"). Só cria registro novo se NÃO houver leitura do código.
    // ════════════════════════════════════════════════════════════════════════
    app.post('/v1/historico/impressao', exigeLeitura, rota(async (req, res) => {
        const b = req.body || {};
        const codigo = b.codigo != null ? String(b.codigo).trim() : '';
        if (!codigo) return erro(res, 400, 'CODIGO_AUSENTE', 'codigo obrigatório');

        // 1) Existe leitura desse código? Anexa a impressão a ela (idempotente).
        const existente = historico.ultimaPorCodigo(codigo);
        if (existente) {
            historico.marcarImpresso(existente.id); // emite 'impresso' se mudou
            return res.json({ ok: true, id: existente.id, anexado: true });
        }

        // 2) Não havia consulta desse código: cria um registro (origem app) impresso.
        const dispositivo = b.dispositivo ? String(b.dispositivo).trim() : '';
        const leitura = historico.registrar({
            terminal: dispositivo ? `App – ${dispositivo}` : 'App SIC Printer',
            serial: b.deviceId ? String(b.deviceId).trim() : '',
            codigo,
            nome: b.descricao != null ? String(b.descricao).trim() : '',
            preco: b.preco != null ? String(b.preco).trim() : '',
            hora: new Date().toLocaleTimeString('pt-BR'),
            status: 'ok',
        });
        historico.marcarImpresso(leitura.id);
        res.json({ ok: true, id: leitura.id, anexado: false });
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  4.8  USUÁRIOS (lista informativa, NUNCA a senha)
    // ════════════════════════════════════════════════════════════════════════
    app.get('/v1/usuarios', exigeLeitura, rota(async (req, res) => {
        const rows = await query(`
            SELECT LTRIM(RTRIM(CAST(nome AS nvarchar(60)))) AS nome, nivel, inativo
            FROM TABUSER ORDER BY nome`);
        res.json({
            itens: rows.map(r => ({
                nome:    r.nome || '',
                nivel:   r.nivel != null ? r.nivel : null,
                inativo: !!r.inativo,
            })),
        });
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  4.9  AUTENTICAR ADMIN (validação server-side; senha nunca sai daqui)
    // ════════════════════════════════════════════════════════════════════════
    app.post('/v1/auth', exigeLeitura, rota(async (req, res) => {
        const nome  = req.body && typeof req.body.nome  === 'string' ? req.body.nome  : null;
        const senha = req.body && typeof req.body.senha === 'string' ? req.body.senha : null;
        if (!nome || senha == null) return erro(res, 400, 'PARAM_INVALIDO', 'nome/senha ausentes');

        // Compara nome+senha no servidor. 401 genérico — não revela qual parte falhou.
        const row = await queryOne(`
            SELECT TOP 1 LTRIM(RTRIM(CAST(nome AS nvarchar(60)))) AS nome, nivel, inativo
            FROM TABUSER
            WHERE nome = @nome AND senha = @senha`, { nome, senha });

        if (!row || row.nivel == null || row.nivel < 3 || row.inativo) {
            return erro(res, 401, 'CREDENCIAL_INVALIDA', 'Credencial inválida');
        }
        res.json({ ok: true, usuario: { nome: row.nome || '', nivel: row.nivel, inativo: !!row.inativo } });
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  3.  PROVISIONAMENTO — payload + QR (protegidos por token de escrita)
    // ════════════════════════════════════════════════════════════════════════
    function montarPayload(st, baseUrl, empresa) {
        const p = { v: 1, tipo: 'sicprinter-http', baseUrl, token: st.tokenLeitura };
        if (st.tokenEscrita) p.tokenEscrita = st.tokenEscrita;
        if (empresa) p.empresa = empresa;
        return p;
    }

    // baseUrl: usa ?baseUrl= se vier; senão deriva dos headers (atrás do IIS HTTPS).
    function baseUrlDoRequest(req) {
        const q = req.query && req.query.baseUrl;
        if (q) return String(q).replace(/\/+$/, '');
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
        const host  = (req.headers['x-forwarded-host'] || req.headers['host'] || '').split(',')[0].trim();
        return `${proto}://${host}`.replace(/\/+$/, '');
    }

    app.get('/v1/provision/payload', exigeEscrita, rota(async (req, res) => {
        res.json(montarPayload(req._sic, baseUrlDoRequest(req), await lerEmpresa()));
    }));

    app.get('/v1/provision/qr', exigeEscrita, rota(async (req, res) => {
        const payload = JSON.stringify(montarPayload(req._sic, baseUrlDoRequest(req), await lerEmpresa()));
        const png = await QRCode.toBuffer(payload, { type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M' });
        res.type('image/png');
        res.set('Cache-Control', 'no-store');
        res.send(png);
    }));

    // ════════════════════════════════════════════════════════════════════════
    //  PAINEL LOCAL (/api/sicprinter/*) — gerência feita pela tela de Ajustes.
    //  Mesma postura dos demais /api/* do GERTEC (LAN/painel local).
    //  Estes NÃO exigem Bearer: são a UI administrativa local que cria os tokens.
    // ════════════════════════════════════════════════════════════════════════

    // Status (sem revelar os tokens, só se existem). Empresa vem do SQL.
    app.get('/api/sicprinter/status', async (req, res) => {
        const st = lerStore();
        res.json({
            habilitado: !!st.habilitado,
            empresa: await lerEmpresa(),
            temTokens: !!(st.tokenLeitura && st.tokenEscrita),
            criadoEm: st.criadoEm || null,
        });
    });

    // Habilitar/desabilitar. Ao habilitar sem tokens, gera o par.
    app.post('/api/sicprinter/config', (req, res) => {
        try {
            const st = lerStore();
            if (req.body.habilitado !== undefined) st.habilitado = !!req.body.habilitado;
            if (st.habilitado && !(st.tokenLeitura && st.tokenEscrita)) {
                st.tokenLeitura = novoToken();
                st.tokenEscrita = novoToken();
                st.criadoEm = new Date().toISOString();
            }
            salvarStore(st);
            res.json({ ok: true, habilitado: st.habilitado, temTokens: !!(st.tokenLeitura && st.tokenEscrita) });
        } catch (e) {
            res.status(500).json({ erro: e.message });
        }
    });

    // Rotaciona (revoga) o par de tokens — invalida o QR antigo.
    app.post('/api/sicprinter/rotacionar', (req, res) => {
        try {
            const st = lerStore();
            st.tokenLeitura = novoToken();
            st.tokenEscrita = novoToken();
            st.criadoEm = new Date().toISOString();
            salvarStore(st);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ erro: e.message });
        }
    });

    // QR para a tela de Ajustes (embute o token; é a UI local que provisiona o app).
    app.get('/api/sicprinter/qr', async (req, res) => {
        try {
            const st = lerStore();
            if (!(st.tokenLeitura && st.tokenEscrita)) return res.status(409).json({ erro: 'Tokens não gerados' });
            const payload = JSON.stringify(montarPayload(st, baseUrlDoRequest(req), await lerEmpresa()));
            const png = await QRCode.toBuffer(payload, { type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M' });
            res.type('image/png');
            res.set('Cache-Control', 'no-store');
            res.send(png);
        } catch (e) {
            res.status(500).json({ erro: e.message });
        }
    });

    console.log('[SICPRINTER] API HTTP montada em /v1/* (' + (lerStore().habilitado ? 'habilitada' : 'desabilitada') + ')');
};
