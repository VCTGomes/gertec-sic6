const net = require('net');
const fs = require('fs');
const path = require('path');
const { buscarPrecoLocal: buscarPrecoSicweb } = require('../routes/produtos');

const DB_PATH = path.join(__dirname, '../data/temp/bdTempLeitura.json');

// --- Funções de Banco de Dados ---
function lerHistorico() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = fs.readFileSync(DB_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) { console.error('Erro ao ler DB:', e.message); }
    return [];
}

function salvarLeitura(leitura) {
    const hist = lerHistorico();
    hist.unshift(leitura);
    if (hist.length > 200) hist.pop();
    fs.writeFileSync(DB_PATH, JSON.stringify(hist, null, 2));
}

// --- Função de Sanitização ---
function sanitizarNome(nome) {
    return nome
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9._/]/g, "");
}

// --- Protocolo e Auxiliares ---
module.exports = function (io) {
    const terminais = {};
    const socketsTCP = {}; 
    const modosImpressao = {};

    // Constantes do Protocolo Gertec TC-506
    const IDwGetIdentify   = 0x13;
    const RIDwGetIdentify  = 0x14;
    const IDContinue       = 0x15;
    const RIDContinue      = 0x16;
    const IDvLive          = 0x11;
    const IdaReaderScanner = 0x59;
    const IDwSerialData    = 0x23;
    const IDvDispClear     = 0x21;
    
    // IDs de Arquivo (Confirmados pela sua doc)
    const IDvRecvFile      = 0x61; // 97 decimal
    const RIDvRecvFile     = 0x62; // 98 decimal
    const IDwWriteFile     = 0x63; 
    const RIDwWriteFile    = 0x64; 
    const IDwDelFile       = 0xB8; 
    const RIDwDelFile      = 0xB9; 

    // --- INTEGRAÇÃO COM A IMPRESSORA (Versão Back-end) ---
    async function imprimirEtiqueta(codigo, ip, io, logDebugCallback) {
        if (!codigo || codigo === '-') {
            logDebugCallback(ip, '[IMPRESSÃO] Código inválido.');
            return false;
        }
        try {
            const url = `${process.env.IMPRESSORA_URL}${codigo}`;
            const res = await fetch(url);
            
            if (res.ok) {
                logDebugCallback(ip, `[IMPRESSÃO] Etiqueta ${codigo} enviada com sucesso!`);
                io.emit('statusImpressao', { sucesso: true, mensagem: `Etiqueta ${codigo} impressa!` }); 
                return true;
            } else {
                logDebugCallback(ip, `[IMPRESSÃO/ERRO] Falha na API. Status: ${res.status}`);
                io.emit('statusImpressao', { sucesso: false, mensagem: `Erro na API: ${res.status}` });
                return false;
            }
        } catch (e) {
            logDebugCallback(ip, `[IMPRESSÃO/ERRO] Exceção: ${e.message}`);
            io.emit('statusImpressao', { sucesso: false, mensagem: `Erro de conexão na impressora.` });
            return false;
        }
    }

    // === SINCRONIZAÇÃO COM O FRONTEND ===
    io.on('connection', (socket) => {
        socket.emit('historicoLeituras', lerHistorico());
        socket.emit('atualizarTerminaisTC', Object.values(terminais));

        socket.on('limparHistorico', () => {
            fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
            io.emit('historicoLeituras', []);
        });

        // 1. LISTAR MEMÓRIA
        socket.on('listarMidias', (data) => {
            const tSocket = socketsTCP[data.ip];
            if (tSocket) {
                io.emit('logDebug', { ip: data.ip, msg: `[SYS] Lendo índice de mídias (all_medias.conf)` });
                const arg = Buffer.alloc(128);
                arg.write("CONF_DIR/all_medias.conf", 0, "ascii");
                enviarPacote(tSocket, data.ip, IDvRecvFile, arg);
            }
        });

        // 2. SOLICITAR CONTEÚDO (Visualizar imagem ou arquivo)
        socket.on('solicitarMidia', (data) => {
            const tSocket = socketsTCP[data.ip];
            if (tSocket) {
                io.emit('logDebug', { ip: data.ip, msg: `[SYS] Solicitando download do terminal: ${data.nomeArquivo}` });
                const arg = Buffer.alloc(128);
                arg.write(data.nomeArquivo, 0, "ascii");
                enviarPacote(tSocket, data.ip, IDvRecvFile, arg);
            }
        });

        // 3. GRAVAR PLAYLIST OU UPLOAD 
        socket.on('uploadMidia', (data) => {
            const tSocket = socketsTCP[data.ip];
            if (tSocket) {
                const nomeLimpo = sanitizarNome(data.nomeArquivo);
                io.emit('logDebug', { ip: data.ip, msg: `[TX] Gravando na memória: ${nomeLimpo}` });
                
                const fileBuffer = Buffer.from(data.base64, 'base64');
                const header = Buffer.alloc(128);
                header.write(nomeLimpo, 0, "ascii"); 
                
                const payload = Buffer.concat([header, fileBuffer]);
                enviarPacote(tSocket, data.ip, IDwWriteFile, payload);
            }
        });

        // 4. APAGAR ARQUIVO
        socket.on('apagarMidia', (data) => {
            const tSocket = socketsTCP[data.ip];
            if (tSocket) {
                io.emit('logDebug', { ip: data.ip, msg: `[TX] Deletando: ${data.nomeArquivo}` });
                const arg = Buffer.from(data.nomeArquivo, "ascii");
                enviarPacote(tSocket, data.ip, IDwDelFile, arg);
            }
        });
    });

    const mapPacotes = {
        0x13: 'IDwGetIdentify', 0x14: 'RIDwGetIdentify',
        0x11: 'IDvLive', 0x59: 'IdaReaderScanner',
        0x23: 'IDwSerialData', 0x21: 'IDvDispClear',
        0x61: 'IDvRecvFile', 0x62: 'RIDvRecvFile',
        0x63: 'IDwWriteFile', 0x64: 'RIDwWriteFile',
        0xB8: 'IDwDelFile', 0xB9: 'RIDwDelFile'
    };

    function nomePacote(id) { return mapPacotes[id] || `0x${id.toString(16).toUpperCase()}`; }

    function criarPacote(id, argumento = Buffer.alloc(0)) {
        const pacote = Buffer.alloc(1 + 2 + 4 + argumento.length);
        pacote.writeUInt8(0x02, 0); 
        pacote.writeUInt16LE(id, 1);
        pacote.writeUInt32LE(argumento.length, 3);
        if (argumento.length > 0) argumento.copy(pacote, 7);
        return pacote;
    }

    function enviarPacote(socket, ip, id, argumento = Buffer.alloc(0)) {
        io.emit('logDebug', { ip, msg: `[TX] ${nomePacote(id)} | Bytes: ${argumento.length}` });
        socket.write(criarPacote(id, argumento));
    }

    function gerarBloco(x, y, texto, fonte, size, corFore) {
        const bloco = Buffer.alloc(170);
        bloco.writeUInt16LE(x, 0); bloco.writeUInt16LE(y, 2);
        Buffer.from(texto.substring(0, 127), 'utf8').copy(bloco, 4);
        Buffer.from(fonte.substring(0, 31), 'ascii').copy(bloco, 132);
        bloco.writeUInt16LE(size, 164); bloco.writeUInt16LE(corFore, 166);
        bloco.writeUInt16LE(0xFFFF, 168); 
        return bloco;
    }

    const server = net.createServer((socket) => {
        
        const ip = socket.remoteAddress.replace(/^.*:/, '');
        socketsTCP[ip] = socket;
        io.emit('logDebug', { ip, msg: `[SYS] Terminal Conectado` });
        enviarPacote(socket, ip, IDwGetIdentify);

        let buffer = Buffer.alloc(0);
        let keepAlive;

        socket.on('data', (chunk) => {
    //        io.emit('logDebug', { ip, msg: `Recebido: ${chunk}` });
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 7) {
                if (buffer[0] !== 0x02) { buffer = buffer.subarray(1); continue; }
                const id = buffer.readUInt16LE(1);
                const tam = buffer.readUInt32LE(3);
                const total = 7 + tam;
                if (buffer.length < total) break;
                const arg = buffer.subarray(7, total);
                buffer = buffer.subarray(total);

                io.emit('logDebug', { ip, msg: `[RX] ${nomePacote(id)}` });

                if (id === RIDwGetIdentify) {
                    enviarPacote(socket, ip, IDContinue, Buffer.from([0x01, 0x00, 0x00, 0x00]));
                }
                else if (id === RIDContinue) {
                    terminais[ip] = { id: ip, ip, modelo: 'TC-506 Mídia', status: 'Online', conectadoEm: new Date().toLocaleTimeString('pt-BR') };
                    io.emit('atualizarTerminaisTC', Object.values(terminais));
                    const pClear = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
                    const pBoasVindas = criarPacote(IDwSerialData, gerarBloco(80, 100, 'PASSE O PRODUTO', 'DejaVuSans-Bold.ttf', 30, 0x010F));
                    socket.write(Buffer.concat([pClear, pBoasVindas]));
                    if (keepAlive) clearInterval(keepAlive);
                    keepAlive = setInterval(() => enviarPacote(socket, ip, IDvLive), 30000);
                }
                else if (id === RIDvRecvFile) {
                    // Lógica CORRIGIDA baseada no manual enviado
                    
                    // 1. O nome do arquivo está nos primeiros 128 bytes
                    let fimNome = arg.indexOf(0);
                    if (fimNome === -1 || fimNome > 128) fimNome = 128;
                    const nomeArq = arg.subarray(0, fimNome).toString('ascii').trim();
                    
                    // 2. O Status (1=Encontrado, 0=Não Encontrado) está no byte 128 e tem 4 bytes
                    const status = arg.readUInt32LE(128);

                    if (status === 0) {
                        io.emit('logDebug', { ip, msg: `[SYS] Arquivo não encontrado no terminal: ${nomeArq}` });
                        continue; // Arquivo não existe, ignora processamento
                    }

                    // 3. A MÁGICA: Os bytes reais do arquivo começam a partir do byte 132!
                    let conteudo = arg.subarray(132);

                    if (nomeArq.includes('all_medias.conf')) {
                        let txt = conteudo.toString('utf8');
                        let corrigido = txt.replace(/media\d+=(.+\.(png|jpg|jpeg|bmp|avi|mp4|gif|mov))/gi, 'INT_MEM/$1');
                        io.emit('retornoListaMidias', { ip, nome: nomeArq, conteudo: corrigido });
                    } 
                    else if (nomeArq.includes('medias.conf')) {
                        io.emit('retornoPlaylistTC', { ip, conteudo: conteudo.toString('utf8') });
                    }
                    else if (nomeArq.includes('.conf')) {
                        io.emit('retornoListaMidias', { ip, nome: nomeArq, conteudo: conteudo.toString('utf8') });
                    } else {
                        // Como tiramos o status da frente, a base64 agora é pura e a imagem vai abrir!
                        io.emit('retornoMidia', { ip, nome: nomeArq, base64: conteudo.toString('base64') });
                    }
                }
                else if (id === RIDwWriteFile || id === RIDwDelFile) {
                    const sucesso = arg.readUInt32LE(0) === 1;
                    io.emit('logDebug', { ip, msg: `[SYS] Operação: ${sucesso ? 'OK' : 'FALHA'}` });
                    io.emit('statusUpload', { sucesso, mensagem: sucesso ? 'Concluído!' : 'Erro no terminal.' });
                }
             //   else if (id === IdaReaderScanner) {
            //        io.emit('logDebug', { ip, msg: `Algo recebido: ${chunk}` });
            //        const match = arg.toString('ascii').match(/\d{4,14}/); 
             //       if (match) processarLeituraAsync(socket, ip, match[0]);
             //   }

             //Leitura com proteção de QR Code

            else if (id === IdaReaderScanner) {
                const leitura = arg.toString('ascii').trim();
                io.emit('logDebug', { ip, msg: `Algo recebido: ${leitura}` });
                if (/(http|https|www)/i.test(leitura)) {
                
                io.emit('logDebug', { ip, msg: `[BLOQUEIO] QR Code detectado.` });
                const pClear = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
                const pErro = criarPacote(IDwSerialData, gerarBloco(30, 80, 'Use o codigo de barras,', 'DejaVuSans-Bold.ttf', 25, 0x010F));
                const pErro2 = criarPacote(IDwSerialData, gerarBloco(30, 120, 'nao o QR Code.', 'DejaVuSans-Bold.ttf', 25, 0x010F));
                socket.write(Buffer.concat([pClear, pErro,pErro2]));
                    return; 
                }   else {
                    io.emit('logDebug', { ip, msg: `Algo recebido: ${chunk}` });
                    const match = arg.toString('ascii').match(/\d{4,14}/); 
                    if (match) processarLeituraAsync(socket, ip, match[0]);
                }
            }
            }
        });

// 1. AQUI ESTÁ A PROTEÇÃO CONTRA A QUEDA DE ENERGIA/DESLIGAMENTO
        socket.on('error', (err) => {
            io.emit('logDebug', { ip, msg: `[ERRO DE REDE] Queda brusca no terminal TC-506: ${err.code}` });
            
            // Limpa o fantasma da memória para não travar o painel
            if (keepAlive) clearInterval(keepAlive);
            delete terminais[ip]; 
            delete socketsTCP[ip];
            io.emit('atualizarTerminaisTC', Object.values(terminais));
        });

        // 2. AQUI É O DESLIGAMENTO NORMAL E EDUCADO
        socket.on('close', () => {
            if (keepAlive) clearInterval(keepAlive);
            delete terminais[ip]; 
            delete socketsTCP[ip];
            io.emit('atualizarTerminaisTC', Object.values(terminais));
        });
    }); // Fim do net.createServer
  

    // --- Lógica de Negócio com Tentativa Dupla (RESTAURADA) ---
    async function processarLeituraAsync(socket, ip, codigoBruto) {
        try {
            io.emit('logDebug', { ip, msg: `[AVISO] Código recebido: ${codigoBruto}` });
            let codigo = codigoBruto.trim();
            io.emit('logDebug', { ip, msg: `[AVISO] Código limpo: ${codigoBruto}` });
            
            // Ajuste inicial para EAN-13
            if (codigo.length === 12) {
                codigo = '0' + codigo;
            }

            // --- GATILHO DO MODO IMPRESSÃO ---
            if (codigo === '2985141673178' || codigo === '02985141673178') {
                modosImpressao[ip] = Date.now() + 60000;
                io.emit('logDebug', { ip, msg: `[SYS] MODO IMPRESSÃO ATIVADO por 1 minuto.` });
                
                // Desenha na tela do TC-506 o aviso de modo ativo
                const pClear = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
                const p1 = criarPacote(IDwSerialData, gerarBloco(30, 80, 'MODO IMPRESSAO', 'DejaVuSans-Bold.ttf', 25, 0x010F));
                const p2 = criarPacote(IDwSerialData, gerarBloco(30, 120, 'ATIVO (1 MIN)', 'DejaVuSans-Bold.ttf', 25, 0x010F));
                socket.write(Buffer.concat([pClear, p1, p2]));
                return;
            }
            // ---------------------------------

            io.emit('logDebug', { ip, msg: `[TENTATIVA 1] Consultando com zeros: ${codigo}` });
            let produto = await buscarPrecoSicweb(codigo);

            // FALLBACK: Se não encontrou e o código começa com zero...
            if (!produto && codigo.startsWith('0')) {
                const codigoSemZero = codigo.replace(/^0+/, ''); // Remove TODOS os zeros à esquerda
                io.emit('logDebug', { ip, msg: `[TENTATIVA 2] Tentando sem zeros: ${codigoSemZero}` });
                
                produto = await buscarPrecoSicweb(codigoSemZero);
                
                if (produto) {
                    codigo = codigoSemZero; // Se achou na segunda tentativa, usa o código limpo
                }
            }

            // Exibe Erro se não achou em nenhuma tentativa
// Exibe Erro se não achou em nenhuma tentativa
            if (!produto) {
                io.emit('logDebug', { ip, msg: `[AVISO] Produto não encontrado em nenhuma das tentativas.` });
                const pClear = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
                const pErro = criarPacote(IDwSerialData, gerarBloco(30, 80, 'PRODUTO NAO ENCONTRADO', 'DejaVuSans-Bold.ttf', 25, 0x010F));
                socket.write(Buffer.concat([pClear, pErro]));
                
                // --- NOVIDADE: Registra pro painel a falha de leitura ---
                const leituraErro = { 
                    terminal: `TC-506 (${ip})`, 
                    codigo: codigo, 
                    nome: '❌ NÃO ENCONTRADO', 
                    preco: '-', 
                    hora: new Date().toLocaleTimeString('pt-BR'),
                    status: 'erro'
                };
                salvarLeitura(leituraErro);
                io.emit('novaLeitura', leituraErro);
                return;
            }

            // Sucesso: Salva e exibe no Display e Web
            const leitura = { 
                terminal: `TC-506 (${ip})`, 
                codigo: codigo, 
                nome: produto.nome, 
                preco: produto.preco, 
                hora: new Date().toLocaleTimeString('pt-BR'),
                status: 'ok'
            };
            
            salvarLeitura(leitura);
            io.emit('novaLeitura', leitura);
                        
                // 1. Função interna rápida para limpar acentos (remove Á, Ç, õ, etc)
// 1. Função interna rápida para limpar acentos
                const removerAcentos = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                const nomeSemAcentos = removerAcentos(produto.nome);
                const nomeExibicao = nomeSemAcentos.length > 25 ? nomeSemAcentos.substring(0, 22) + '...' : nomeSemAcentos;

                // Prepara os blocos comuns (Código e Nome)
                const pClear = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
                const p1 = criarPacote(IDwSerialData, gerarBloco(30, 75, codigo, 'DejaVuSans.ttf', 16, 0x010F));
                const p2 = criarPacote(IDwSerialData, gerarBloco(30, 40, nomeExibicao, 'DejaVuSans.ttf', 25, 0x010F));

                // --- VERIFICA SE DEVE IMPRIMIR ---
                if (modosImpressao[ip] && Date.now() <= modosImpressao[ip]) {
                    io.emit('logDebug', { ip, msg: `[SYS] Enviando para impressão. MODO ATIVO.` });
                    
                    // 1. Desenha "IMPRIMINDO..." no lugar do preço
                    const pStatus1 = criarPacote(IDwSerialData, gerarBloco(30, 170, 'IMPRIMINDO...', 'DejaVuSans-Bold.ttf', 35, 0x010F));
                    socket.write(Buffer.concat([pClear, p1, p2, pStatus1]));

                    // Wrapper simples pro log do emitir
                    const logCallback = (ipRef, msgRef) => io.emit('logDebug', { ip: ipRef, msg: msgRef });
                    
                    // 2. Chama a API
                    const sucessoImpressao = await imprimirEtiqueta(codigo, ip, io, logCallback);

                    // 3. Atualiza a tela com o resultado
                    const pClearStatus = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
                    const msgResultado = sucessoImpressao ? 'IMPRESSO OK!' : 'ERRO IMPRESSAO';
                    const pStatus2 = criarPacote(IDwSerialData, gerarBloco(30, 170, msgResultado, 'DejaVuSans-Bold.ttf', 35, 0x010F));
                    socket.write(Buffer.concat([pClearStatus, p1, p2, pStatus2]));

                } else {
                    // Comportamento NORMAL: Exibe o preço grandão
                    const p4 = criarPacote(IDwSerialData, gerarBloco(30, 170, removerAcentos(produto.preco), 'DejaVuSans-Bold.ttf', 60, 0x010F));
                    const p5 = criarPacote(IDwSerialData, gerarBloco(250, 170, '', 'DejaVuSans-Bold.ttf', 30, 0x010F)); 
                    socket.write(Buffer.concat([pClear, p1, p2, p4, p5]));
                }

        } catch (e) { 
            io.emit('logDebug', { ip, msg: `[ERRO] Falha no processamento: ${e.message}` }); 
            const pClear = criarPacote(IDvDispClear, Buffer.from([0x04, 0x01]));
            const pErro = criarPacote(IDwSerialData, gerarBloco(30, 80, 'ERRO NO SERVIDOR', 'DejaVuSans-Bold.ttf', 25, 0x010F));
            socket.write(Buffer.concat([pClear, pErro]));
        }
    }
    
    server.listen(process.env.PORT_TC || 16510, '0.0.0.0', () => console.log(`[GERTEC] TC-506 escutando porta ${process.env.PORT_TC || 16510}`));
};