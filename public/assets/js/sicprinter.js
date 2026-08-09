/* ════════════════════════════════════════════════════════════════════════════
 *  Conectar Celular — UI do provisionamento da API SIC Printer (HTTP)
 *  ----------------------------------------------------------------------------
 *  Script isolado, só toca a tela "Conectar Celular". Conversa apenas com os
 *  endpoints locais /api/sicprinter/*. Não envia dado nenhum para fora.
 * ════════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    function msg(texto, tipo) {
        const el = $('msgSic');
        if (!el) return;
        // Variantes de mensagem do design system (gertec.css / tokens M3)
        const cores = {
            ok:   'g-msg--success',
            erro: 'g-msg--error',
            info: 'g-msg--info',
        };
        el.className = 'g-msg ' + (cores[tipo] || cores.info);
        el.innerText = texto;
    }
    function limparMsg() { const el = $('msgSic'); if (el) el.classList.add('hidden'); }

    // Recarrega o QR com cache-busting (token pode ter mudado)
    function recarregarQr() {
        const img = $('sicQrImg');
        if (img) img.src = '/api/sicprinter/qr?baseUrl=' + encodeURIComponent(location.origin) + '&t=' + Date.now();
    }

    function refletirEstado(habilitado) {
        const area = $('sicArea');
        if (!area) return;
        if (habilitado) { area.classList.remove('hidden'); recarregarQr(); }
        else            { area.classList.add('hidden'); }
    }

    // Carrega status atual ao abrir o modal
    async function carregarStatus() {
        limparMsg();
        try {
            const r = await fetch('/api/sicprinter/status');
            const d = await r.json();
            $('chkSicHabilitado').checked = !!d.habilitado;
            $('sicEmpresa').innerText = d.empresa || '(não definida no SIC)';
            // Endereço = o mesmo que o navegador usa (domínio HTTPS atrás do IIS),
            // igual ao que o QR codifica. O servidor, por trás do IIS, veria localhost.
            $('sicBaseUrl').innerText = location.origin;
            refletirEstado(d.habilitado && d.temTokens);
        } catch (e) {
            msg('Não foi possível carregar o estado.', 'erro');
        }
    }

    // Persiste habilitado (gera tokens automaticamente ao habilitar)
    async function salvar() {
        try {
            const r = await fetch('/api/sicprinter/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ habilitado: $('chkSicHabilitado').checked }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.erro || 'falha');
            refletirEstado(d.habilitado && d.temTokens);
            return true;
        } catch (e) {
            msg('Erro ao salvar.', 'erro');
            return false;
        }
    }

    // Abre o modal (chamado pelo botão em Ajustes)
    window.abrirModalCelular = async function () {
        await carregarStatus();
        if (typeof abrirModalEl === 'function') abrirModalEl('modalCelular');
    };

    // Liga/desliga o acesso
    document.addEventListener('change', async (e) => {
        if (e.target && e.target.id === 'chkSicHabilitado') {
            const ok = await salvar();
            if (ok) msg(e.target.checked ? 'Acesso habilitado.' : 'Acesso desabilitado.', e.target.checked ? 'ok' : 'info');
        }
    });

    // Rotaciona tokens (revoga QR antigo)
    window.rotacionarSicToken = async function () {
        if (!confirm('Gerar um novo token vai invalidar o QR atual. Os celulares já conectados precisarão escanear de novo. Continuar?')) return;
        try {
            const r = await fetch('/api/sicprinter/rotacionar', { method: 'POST' });
            const d = await r.json();
            if (!r.ok) throw new Error(d.erro || 'falha');
            recarregarQr();
            msg('Novo token gerado. Reescaneie o QR no app.', 'ok');
        } catch (e) {
            msg('Erro ao gerar novo token.', 'erro');
        }
    };
})();
