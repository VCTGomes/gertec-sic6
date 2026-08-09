/* ════════════════════════════════════════════════════════════════════════════
 *  Precificação — produtos a imprimir e produtos já impressos
 *  ----------------------------------------------------------------------------
 *  Dono do domínio. Junta as duas metades da pergunta "o preço da gôndola bate
 *  com o do sistema?":
 *
 *    - a imprimir  → tabest1.ultreaj (preenchido pelo ESTOQUE e pelo SIC Delphi
 *                    legado, então pega alteração feita em qualquer um dos dois)
 *    - impressos   → services/impressoes.js (unificado: ESTOQUE, app SIC Printer
 *                    e terminais), com retenção de 7 dias
 *
 *  O ESTOQUE consome isto pela HTTP; não duplica nem a consulta nem a regra.
 * ════════════════════════════════════════════════════════════════════════════ */

const { query } = require('../database');
const impressoes = require('./impressoes');

const DIAS_MAX = 7;

// Janela pedida, limitada a 1..7 dias (1 = hoje, 2 = hoje e ontem, ...)
function janelaDias(v) {
    const n = parseInt(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(Math.max(n, 1), DIAS_MAX);
}

// Data (YYYY-MM-DD) de N-1 dias atrás — dias=1 devolve hoje.
function dataCorte(dias) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (dias - 1));
    return d.toISOString().split('T')[0];
}

// Produtos reajustados na janela, cada um com a última etiqueta impressa.
async function alteracoes(diasBruto) {
    const dias  = janelaDias(diasBruto);
    const corte = dataCorte(dias);

    const rows = await query(`
        SELECT
            t1.controle                                    AS id,
            CAST(ISNULL(t1.codigo,'') AS nvarchar(30))     AS codigo,
            CAST(t1.produto AS nvarchar(300))              AS descricao,
            ISNULL(t1.precovenda, 0)                       AS preco_venda,
            ISNULL(t1.precocusto, 0)                       AS preco_custo,
            ISNULL(t1.lucro, 0)                            AS lucro,
            CAST(ISNULL(t1.unidade,'UN') AS nvarchar(10))  AS unidade,
            CAST(ISNULL(t8.setor,'') AS nvarchar(100))     AS categoria_nome,
            CONVERT(varchar(10), t1.ultreaj, 23)           AS ultimo_reajuste
        FROM tabest1 t1
        LEFT JOIN tabest8 t8 ON t8.controle = t1.lksetor
        WHERE (t1.inativo = 0 OR t1.inativo IS NULL)
          AND t1.ultreaj IS NOT NULL
          AND t1.ultreaj >= @corte
        ORDER BY t1.ultreaj DESC, CAST(t1.produto AS nvarchar(300))
    `, { corte });

    const ultimas = impressoes.ultimasPorCodigos(rows.map(r => r.codigo).filter(Boolean));

    const data = rows.map(r => {
        const imp   = ultimas[impressoes.normalizar(r.codigo)] || null;
        const atual = Number(r.preco_venda || 0);

        // Divergente = já foi impresso na janela de retenção, mas por outro
        // preço. Sem impressão registrada não dá para afirmar nada — por isso
        // 'sem_registro' em vez de assumir que está errado.
        let situacao = 'sem_registro';
        if (imp && imp.preco !== null && imp.preco !== undefined) {
            situacao = Math.abs(Number(imp.preco) - atual) > 0.001 ? 'divergente' : 'ok';
        }

        return {
            ...r,
            impresso_em:      imp?.ts     ?? null,
            preco_impresso:   imp?.preco  ?? null,
            origem_impressao: imp?.origem ?? null,
            situacao,
        };
    });

    return {
        dias,
        corte,
        total:       data.length,
        divergentes: data.filter(d => d.situacao === 'divergente').length,
        data,
    };
}

module.exports = { alteracoes, janelaDias, DIAS_MAX };
