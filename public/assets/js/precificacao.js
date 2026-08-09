/* ════════════════════════════════════════════════════════════════════════════
 *  Aba Precificação
 *  ----------------------------------------------------------------------------
 *  Produtos cujo preço mudou (coluna `ultreaj` do SIC — pega alteração feita
 *  no ESTOQUE e no SIC Delphi legado), cruzados com o preço da última etiqueta
 *  impressa. Divergente = o que está na gôndola não é o que está no sistema.
 *
 *  O histórico de impressões é unificado (estoque, app SIC Printer e
 *  terminais), com retenção de 7 dias.
 * ════════════════════════════════════════════════════════════════════════════ */

let _precItens         = [];   // resultado bruto da API
let _precJanela        = 1;    // dias (1 = hoje, 2 = hoje e ontem, 7 = semana)
let _precFiltro        = '';   // busca client-side
let _precSoDivergentes = false;
let _precCarregando    = false;

const _PREC_JANELAS = { 1: 'hoje', 2: 'hoje e ontem', 7: 'nos últimos 7 dias' };

const _PREC_SITUACOES = {
    divergente:   { label: 'Divergente',   icone: 'fa-triangle-exclamation', classe: 'bg-red-100 text-red-700' },
    ok:           { label: 'Impresso',     icone: 'fa-check',                classe: 'bg-emerald-100 text-emerald-700' },
    sem_registro: { label: 'Sem etiqueta', icone: 'fa-minus',                classe: 'bg-gray-100 text-gray-500' },
};

const _PREC_ORIGENS = {
    estoque:  { label: 'Estoque',  icone: 'fa-desktop' },
    app:      { label: 'App',      icone: 'fa-mobile-screen' },
    terminal: { label: 'Terminal', icone: 'fa-barcode' },
};

const _precMoeda = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const _precDataBR = s => {
    if (!s) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; }
    return s;
};

const _precDataHora = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('pt-BR', {
        timeZone: 'America/Bahia',
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
};

const _precEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Carga ────────────────────────────────────────────────────────────────────
async function carregarPrecificacao() {
    if (_precCarregando) return;
    _precCarregando = true;

    const tbody = document.getElementById('tabelaPrecificacao');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-gray-400">
            <i class="fa-solid fa-circle-notch fa-spin text-xl mb-2 block"></i>Carregando...
        </td></tr>`;
    }

    try {
        const r = await fetch(`/api/precificacao/alteracoes?dias=${_precJanela}`);
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.erro || 'Falha ao carregar');

        _precItens = d.data || [];
        _precAtualizarResumo(d);
        _precRender();
    } catch (e) {
        _precItens = [];
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-red-400 font-semibold">
                <i class="fa-solid fa-triangle-exclamation text-xl mb-2 block"></i>${_precEsc(e.message)}
            </td></tr>`;
        }
    } finally {
        _precCarregando = false;
    }
}

function _precAtualizarResumo(d) {
    const elTotal = document.getElementById('precResumoTotal');
    const elDiv   = document.getElementById('precResumoDivergentes');
    if (elTotal) elTotal.innerText = d.total || 0;
    if (elDiv)   elDiv.innerText   = d.divergentes || 0;

    const badge = document.getElementById('badgePrecificacao');
    if (badge) {
        const n = d.divergentes || 0;
        badge.innerText = n;
        badge.classList.toggle('hidden', n === 0);
    }
}

// ── Render ───────────────────────────────────────────────────────────────────
function _precRender() {
    const tbody = document.getElementById('tabelaPrecificacao');
    if (!tbody) return;

    const termo = _precFiltro.trim().toLowerCase();
    const itens = _precItens.filter(p => {
        if (_precSoDivergentes && p.situacao !== 'divergente') return false;
        if (!termo) return true;
        return (p.descricao || '').toLowerCase().includes(termo)
            || (p.codigo || '').toLowerCase().includes(termo);
    });

    const elFiltrados = document.getElementById('precResumoFiltrados');
    if (elFiltrados) elFiltrados.innerText = itens.length;

    if (!itens.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-gray-400">
            <i class="fa-solid fa-check text-xl mb-2 block text-emerald-400"></i>
            Nenhum preço alterado ${_PREC_JANELAS[_precJanela] || ''}.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = itens.map(p => {
        const i   = _precItens.indexOf(p);
        const sit = _PREC_SITUACOES[p.situacao] || _PREC_SITUACOES.sem_registro;
        const org = _PREC_ORIGENS[p.origem_impressao];

        const etiqueta = (p.preco_impresso === null || p.preco_impresso === undefined)
            ? '<span class="text-gray-300">—</span>'
            : `<span class="${p.situacao === 'divergente' ? 'text-red-600 font-bold' : 'text-gray-600'}">${_precMoeda(p.preco_impresso)}</span>`;

        return `
        <tr class="${p.situacao === 'divergente' ? 'bg-red-50/50' : ''} hover:bg-gray-50 transition-colors">
            <td class="px-4 py-3">
                <p class="font-semibold text-gray-800 leading-tight">${_precEsc(p.descricao) || '—'}</p>
                <p class="text-xs font-mono text-gray-400 mt-0.5">
                    ${_precEsc(p.codigo) || '—'} · Reaj: ${_precDataBR(p.ultimo_reajuste)}
                </p>
            </td>
            <td class="px-4 py-3 text-xs text-gray-500 truncate max-w-[140px]">${_precEsc(p.categoria_nome) || '—'}</td>
            <td class="px-4 py-3 text-right font-bold text-gray-800 whitespace-nowrap">${_precMoeda(p.preco_venda)}</td>
            <td class="px-4 py-3 text-right whitespace-nowrap">${etiqueta}</td>
            <td class="px-4 py-3 text-center text-xs text-gray-500 whitespace-nowrap">
                ${_precDataHora(p.impresso_em)}
                ${org ? `<i class="fa-solid ${org.icone} ml-1 text-gray-300" title="${org.label}"></i>` : ''}
            </td>
            <td class="px-4 py-3 text-center">
                <span class="${sit.classe} text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap">
                    <i class="fa-solid ${sit.icone}"></i> ${sit.label}
                </span>
            </td>
            <td class="px-4 py-3 text-center">
                <button id="btnPrintPrec_${i}" onclick="imprimirEtiquetaPrec(${i})"
                        class="bg-gray-700 hover:bg-gray-800 text-white w-8 h-8 rounded-lg text-xs transition-colors"
                        title="Imprimir etiqueta de preço">
                    <i class="fa-solid fa-print"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
}

// ── Controles ────────────────────────────────────────────────────────────────
function precTrocarJanela(dias) {
    _precJanela = parseInt(dias) || 1;
    document.querySelectorAll('[data-prec-janela]').forEach(b => {
        const ativo = Number(b.dataset.precJanela) === _precJanela;
        b.classList.toggle('bg-blue-600',   ativo);
        b.classList.toggle('text-white',    ativo);
        b.classList.toggle('bg-gray-100',  !ativo);
        b.classList.toggle('text-gray-600', !ativo);
    });
    carregarPrecificacao();
}

function filtrarPrecificacao() {
    _precFiltro = document.getElementById('precBusca')?.value || '';
    _precRender();
}

function precToggleDivergentes() {
    _precSoDivergentes = !!document.getElementById('chkPrecDivergentes')?.checked;
    _precRender();
}

// ── Impressão ────────────────────────────────────────────────────────────────
// O registro no histórico é feito pelo servidor (POST /api/imprimir-preco),
// então aqui só refletimos na tela o que acabou de sair na etiqueta.
async function imprimirEtiquetaPrec(i) {
    const p   = _precItens[i];
    const btn = document.getElementById(`btnPrintPrec_${i}`);
    if (!p || !btn) return;

    if (!p.codigo) {
        btn.classList.add('bg-red-600');
        btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        btn.title = 'Produto sem código de barras';
        return;
    }

    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
    btn.disabled  = true;

    try {
        const r = await fetch('/api/imprimir-preco', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ codigo: p.codigo, origem: 'estoque' }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);

        // A etiqueta saiu com o preço atual → deixa de estar divergente.
        p.preco_impresso   = Number(p.preco_venda);
        p.impresso_em      = new Date().toISOString();
        p.origem_impressao = 'estoque';
        p.situacao         = 'ok';
        _precRender();
    } catch (e) {
        console.error('[precificacao] Falha ao imprimir:', e.message);
        btn.innerHTML = orig;
        btn.disabled  = false;
        btn.classList.add('bg-red-600');
        btn.title = `Falha na impressão: ${e.message}`;
    }
}

// ── Histórico de impressões (todas as origens, 7 dias) ───────────────────────
async function carregarImpressoesPrec() {
    const tbody = document.getElementById('tabelaImpressoes');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-gray-400">
        <i class="fa-solid fa-circle-notch fa-spin text-lg mb-2 block"></i>Carregando...
    </td></tr>`;

    try {
        const r = await fetch('/api/impressoes?dias=7');
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.erro || 'Falha ao carregar');

        const itens = d.data || [];
        if (!itens.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-gray-400">
                Nenhuma etiqueta impressa nos últimos 7 dias.
            </td></tr>`;
            return;
        }

        tbody.innerHTML = itens.map(im => {
            const org = _PREC_ORIGENS[im.origem] || { label: im.origem || '—', icone: 'fa-question' };
            return `
            <tr class="hover:bg-gray-50 transition-colors">
                <td class="px-4 py-2.5">
                    <p class="font-semibold text-gray-800 text-xs leading-tight">${_precEsc(im.nome) || '—'}</p>
                    <p class="text-[10px] font-mono text-gray-400">${_precEsc(im.codigo) || '—'}</p>
                </td>
                <td class="px-4 py-2.5 text-right font-bold text-gray-700 text-xs whitespace-nowrap">
                    ${(im.preco === null || im.preco === undefined) ? '—' : _precMoeda(im.preco)}
                </td>
                <td class="px-4 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">${_precDataHora(im.ts)}</td>
                <td class="px-4 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">
                    <i class="fa-solid ${org.icone} text-gray-300 mr-1"></i>${_precEsc(org.label)}
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-red-400">${_precEsc(e.message)}</td></tr>`;
    }
}

function togglePainelImpressoes() {
    const painel  = document.getElementById('painelImpressoes');
    const chevron = document.getElementById('chevronImpressoes');
    if (!painel) return;
    const abrindo = painel.classList.contains('hidden');
    painel.classList.toggle('hidden', !abrindo);
    if (chevron) chevron.style.transform = abrindo ? '' : 'rotate(-90deg)';
    if (abrindo) carregarImpressoesPrec();
}
