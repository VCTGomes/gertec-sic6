const net = require('net');
const fs = require('fs');
const path = require('path');
const { buscarPrecoLocal: buscarPrecoSicweb } = require('../routes/produtos');

const DB_PATH = path.join(__dirname, '../data/temp/bdTempLeitura.json');

// --- Funções de Banco de Dados ---
function lerHistorico() {
    try {
        if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {}
    return [];
}

function salvarLeitura(leitura) {
    const hist = lerHistorico();
    hist.unshift(leitura);
    if (hist.length > 200) hist.pop();
    fs.writeFileSync(DB_PATH, JSON.stringify(hist, null, 2));
}

// --- Higienização ---
function sanitizarNome(nome) {
    return nome
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9._/]/g, ""); 
}

// --- Tradutores de Playlist ---
function tcToBpPlaylist(tcString) {
    const lines = tcString.split('\n');
    let bpString = "<\n";
    let mediaIndex = 0;
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('|')) {
            const parts = line.split('|');
            if (parts.length >= 4) {
                const filename = parts[1].replace('INT_MEM/', '').replace('CONF_DIR/', '');
                bpString += `media_${mediaIndex}=${filename}|${parts[2]}|${parts[3] || '1'}|\n`;
                mediaIndex++;
            }
        }
    }
    bpString += ">";
    return bpString;
}

function bpToTcPlaylist(bpString) {
    const lines = bpString.split('\n');
    let tcString = "<\n";
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('media_')) {
            const eqIndex = line.indexOf('=');
            if (eqIndex !== -1) {
                const data = line.substring(eqIndex + 1);
                const parts = data.split('|');
                if (parts.length >= 3) {
                    tcString += `|INT_MEM/${parts[0]}|${parts[1]}|${parts[2]}|\n`;
                }
            }
        }
    }
    tcString += ">";
    return tcString;
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = function (io) {
    const terminais = {};
    const modosImpressao = {};
    const socketsTCP = {};

    function logDebug(ip, msg) { io.emit('logDebug', { ip, msg }); }

    // --- INTEGRAÇÃO COM A IMPRESSORA (Versão Back-end) ---
async function imprimirEtiqueta(codigo, ip, io, logDebugCallback) {
        if (!codigo || codigo === '-') {
        logDebugCallback(ip, '[IMPRESSÃO] Código inválido.');
        return false; // Retorna false em caso de erro
    }
    try {
        const url = `${process.env.IMPRESSORA_URL}${codigo}`;
        const res = await fetch(url);
        
        if (res.ok) {
            logDebugCallback(ip, `[IMPRESSÃO] Etiqueta ${codigo} enviada com sucesso!`);
            io.emit('statusImpressao', { sucesso: true, mensagem: `Etiqueta ${codigo} impressa!` }); 
            return true; // Retorna true se deu certo
        } else {
            logDebugCallback(ip, `[IMPRESSÃO/ERRO] Falha na API. Status: ${res.status}`);
            io.emit('statusImpressao', { sucesso: false, mensagem: `Erro na API: ${res.status}` });
            return false; // Retorna false se a API recusou
        }
    } catch (e) {
        logDebugCallback(ip, `[IMPRESSÃO/ERRO] Exceção: ${e.message}`);
        io.emit('statusImpressao', { sucesso: false, mensagem: `Erro de conexão na impressora.` });
        return false; // Retorna false se caiu a rede
    }

}

    async function processarLeituraAsync(socket, ip, id, codigoBruto) {
        try {
            let codigo = codigoBruto.trim();
            if (codigo.length === 12) {
                codigo = '0' + codigo;
            } else if (codigo.length > 8 && codigo.length < 12) {
                codigo = codigo.padStart(13, '0');
            }

            // --- GATILHO DO MODO IMPRESSÃO ---
        if (codigo === '2985141673178') {
            modosImpressao[ip] = Date.now() + 60000; // 1 minuto (60.000 ms)
            logDebug(ip, `[SYS] MODO IMPRESSÃO ATIVADO por 1 minuto.`);
            if (!socket.destroyed) {
                // Envia feedback para a tela do BP G2
                socket.write('#MODO IMPRESSAO ATIVO|PASSE O PRODUTO\0');
            }
            return; // Interrompe para não pesquisar esse código no Sicweb
        }

            logDebug(ip, `[BUSCA] Consultando API Sicweb: ${codigo}`);
            let produto = await buscarPrecoSicweb(codigo);

            if (!produto && codigo.startsWith('0')) {
                const codigoSemZero = codigo.replace(/^0+/, '');
                logDebug(ip, `[FALLBACK] Não achou. Tentando sem zeros: ${codigoSemZero}`);
                produto = await buscarPrecoSicweb(codigoSemZero);
                if (produto) codigo = codigoSemZero;
            }

if (!produto) {
                logDebug(ip, `[FALHA] Produto não encontrado em nenhuma tentativa.`);
                if (!socket.destroyed) {
                    logDebug(ip, `[TX] Enviando msg: PRODUTO NAO ENCONTRADO`);
                    socket.write('#PRODUTO NAO ENCONTRADO| \0');
                }
                
                // --- NOVIDADE: Registra e envia pro painel mesmo se não achar ---
                const leituraErro = { 
                    terminal: `${terminais[id] ? terminais[id].modelo : 'Desconhecido'} (${ip})`, 
                    codigo, nome: '❌ NÃO ENCONTRADO', preco: '-', hora: new Date().toLocaleTimeString('pt-BR'), status: 'erro'
                };
                salvarLeitura(leituraErro);
                io.emit('novaLeitura', leituraErro);
                return;
            }

logDebug(ip, `[SUCESSO] Encontrado: ${produto.nome} | R$ ${produto.preco}`);

            const nomeFormatado = produto.nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            
            // --- VERIFICA SE DEVE IMPRIMIR ---
            if (modosImpressao[ip] && Date.now() <= modosImpressao[ip]) {
                logDebug(ip, `[SYS] Enviando para impressão. MODO ATIVO.`);
                
                // 1. Mostra no display que está enviando (linha 1: Nome, linha 2: Status)
                if (!socket.destroyed) {
                    socket.write(`#${nomeFormatado.substring(0, 16)}|IMPRIMINDO...\0`);
                }

                // 2. Aguarda a resposta da API de impressão
                const sucessoImpressao = await imprimirEtiqueta(codigo, ip, io, logDebug);

                // 3. Atualiza o display do BP G2 com o resultado final
                if (!socket.destroyed) {
                    if (sucessoImpressao) {
                        socket.write(`#${nomeFormatado.substring(0, 16)}|IMPRESSO OK!\0`);
                    } else {
                        socket.write(`#${nomeFormatado.substring(0, 16)}|ERRO IMPRESSAO\0`);
                    }
                }
            } else {
                // Comportamento NORMAL: Só exibe o preço se não estiver no modo impressão
                if (!socket.destroyed) {
                    logDebug(ip, `[TX] Enviando preço para a tela do terminal`);
                    socket.write(`#${nomeFormatado}|${produto.preco}\0`);
                }
            }
            
            const leitura = { 
                terminal: `${terminais[id] ? terminais[id].modelo : 'Desconhecido'} (${ip})`, 
                codigo, nome: produto.nome, preco: produto.preco, hora: new Date().toLocaleTimeString('pt-BR'), status: 'ok'
            };
            salvarLeitura(leitura);
            io.emit('novaLeitura', leitura);
            
        } catch (e) { 
            logDebug(ip, `[ERRO NA BUSCA] ${e.message}`);
            if (!socket.destroyed) socket.write('#ERRO NA BUSCA| \0'); 
        }
    }
    
    io.on('connection', (socket) => {
        socket.emit('atualizarTerminaisBP', Object.values(terminais));

        socket.on('listarMidiasBP', ({ ip }) => {
            if (socketsTCP[ip]) {
                logDebug(ip, `[TX] Solicitando lista de mídias (#getlistmedias)`);
                socketsTCP[ip].write('#getlistmedias?\0');
            }
        });

        socket.on('buscarPlaylistBP', ({ ip }) => {
            if (socketsTCP[ip]) {
                logDebug(ip, `[TX] Solicitando playlist atual (#getmediasconf)`);
                socketsTCP[ip].write('#getmediasconf?\0');
            }
        });

        socket.on('salvarPlaylistBP', ({ ip, conteudo }) => {
            const tcp = socketsTCP[ip];
            if (tcp) {
                logDebug(ip, `[TX] Gravando nova playlist...`);
                tcp.write(`#savemediasconf${tcToBpPlaylist(conteudo)}`);
            }
        });

        socket.on('uploadMidiaBP', async ({ ip, nomeArquivo, base64 }) => {
            const tcp = socketsTCP[ip];
            if (tcp && !tcp.destroyed) {
                const nomeLimpo = sanitizarNome(nomeArquivo.replace('INT_MEM/', '').replace('CONF_DIR/', ''));
                logDebug(ip, `[TX] Iniciando upload de: ${nomeLimpo}`);
                const bufferBinario = Buffer.from(base64, 'base64');
                const tamanhoHex = bufferBinario.length.toString(16).toUpperCase().padStart(6, '0');
                tcp.write(`#sendmedia${tamanhoHex}${nomeLimpo}`);
                await wait(500);
                if (!tcp.destroyed) {
                    logDebug(ip, `[TX] Enviando buffer binário (${bufferBinario.length} bytes)...`);
                    tcp.write(bufferBinario);
                }
            }
        });

        socket.on('apagarMidiaBP', ({ ip, nomeArquivo }) => {
            const tcp = socketsTCP[ip];
            if (tcp) {
                const nomeLimpo = nomeArquivo.replace('INT_MEM/', '').replace('CONF_DIR/', '');
                logDebug(ip, `[TX] Solicitando exclusão de: ${nomeLimpo}`);
                tcp.write(`#removemedia${nomeLimpo}`); 
            }
        });
    });

    const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        const ip = socket.remoteAddress.replace(/^.*:/, '');
        const id = `BPG2E_${ip}`;
        let dataBuffer = '';
        let keepAlive;

        // --- PROTEÇÃO CONTRA ECONNRESET ---
        socket.on('error', (err) => {
            if (err.code === 'ECONNRESET') {
                logDebug(ip, `[SYS/ERRO] Conexão resetada pelo terminal.`);
            } else {
                logDebug(ip, `[SYS/ERRO] Erro: ${err.message}`);
            }
            if (keepAlive) clearInterval(keepAlive);
        });

        socketsTCP[ip] = socket;
        terminais[id] = { id, ip, modelo: 'Aguardando...', status: 'Online', conectadoEm: new Date().toLocaleTimeString('pt-BR'), identificado: false };
        io.emit('atualizarTerminaisBP', Object.values(terminais));
        
        logDebug(ip, `[SYS] Novo terminal conectado.`);
        logDebug(ip, `[TX] Enviando confirmação de conexão (#ok)`);
        socket.write('#ok\0');

        socket.on('data', (data) => {
            // REPORTANDO TUDO PRO FRONT END: Exibindo o dado bruto e deixando os null bytes visíveis
            const textoBruto = data.toString('utf8');
            logDebug(ip, `[RX BRUTO] ${textoBruto.replace(/\0/g, '\\0')}`);

            dataBuffer += textoBruto;
            
            if (dataBuffer.includes('<') && dataBuffer.includes('>')) {
                const inicio = dataBuffer.indexOf('<');
                const fim = dataBuffer.lastIndexOf('>') + 1;
                const pl = dataBuffer.substring(inicio, fim);
                logDebug(ip, `[SYS] Conteúdo de playlist identificado e extraído.`);
                io.emit('retornoPlaylistBP', { ip, conteudo: bpToTcPlaylist(pl) });
                dataBuffer = dataBuffer.replace(pl, '');
            }

            while (dataBuffer.includes('\0')) {
                const idx = dataBuffer.indexOf('\0');
                let msg = dataBuffer.substring(0, idx).trim();
                dataBuffer = dataBuffer.substring(idx + 1);
                
                if (!msg) continue;
                
                // Oculta o log de #live no modal para não floodar a tela de debug a cada 15s
                if (msg === '#live') continue;

                if (msg.startsWith('#sendmedia_ok') || msg.startsWith('#removemedia_ok') || msg.startsWith('#savemediasconf_ok')) {
                    const sucesso = msg.endsWith('1');
                    logDebug(ip, `[RX] Resposta de operação de mídia: ${msg} -> ${sucesso ? 'Sucesso' : 'Falha'}`);
                    setTimeout(() => io.emit('statusUpload', { sucesso, mensagem: sucesso ? 'Operação concluída!' : 'Erro no terminal.' }), 1200);
                    continue;
                }

                if (msg.startsWith('#getlistmedias')) {
                    logDebug(ip, `[RX] Recebeu lista de mídias.`);
                    io.emit('retornoListaMidiasBP', { ip, conteudo: msg.replace('#getlistmedias', '').trim() });
                    continue;
                }

                if (msg.startsWith('#')) {
                    // A MÁGICA ESTÁ AQUI: Se for só números depois do #, é código de barras!
                    if (/^#\d+$/.test(msg)) {
                        msg = msg.replace('#', ''); 
                    } else {
                        // Se não for número, é comando de sistema ou identificação do terminal
                        if (!msg.match(/#live|#get|#save|#ok|#remove|#send/) && !terminais[id].identificado) {
                            terminais[id].modelo = msg.replace('#', '');
                            terminais[id].identificado = true;
                            logDebug(ip, `[SYS] Terminal identificado como: ${terminais[id].modelo}`);
                            io.emit('atualizarTerminaisBP', Object.values(terminais));
                        }
                        if (!keepAlive) {
                            logDebug(ip, `[SYS] Iniciando ciclo de Keep Alive (#live) a cada 15s`);
                            socket.write('#live?\0');
                            keepAlive = setInterval(() => !socket.destroyed ? socket.write('#live?\0') : clearInterval(keepAlive), 15000);
                        }
                        continue; 
                    }
                }
                
                logDebug(ip, `[SYS] Processando mensagem como código de barras: ${msg}`);
                processarLeituraAsync(socket, ip, id, msg);
            }
        });

        socket.on('close', () => { 
            if (keepAlive) clearInterval(keepAlive); 
            delete terminais[id]; 
            delete socketsTCP[ip]; 
            io.emit('atualizarTerminaisBP', Object.values(terminais)); 
            logDebug(ip, `[SYS] Conexão encerrada pelo terminal.`);
            console.log(`[-] BP G2 Desconectado: ${ip}`);
        });
    });

    server.listen(process.env.PORT_BP || 6500, '0.0.0.0', () => console.log(`[GERTEC] BP G2 escutando porta ${process.env.PORT_BP || 6500}`));
};