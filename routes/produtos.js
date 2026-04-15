const { query } = require('../database');

async function buscarPrecoLocal(codigoBruto) {
    const codigo = codigoBruto.trim();

    // Tentativa 1: campo codigo
    let rows = await query(`
        SELECT TOP 1
            CAST(produto AS nvarchar(300)) AS nome,
            precovenda AS preco
        FROM tabest1
        WHERE (inativo = 0 OR inativo IS NULL)
          AND CAST(codigo AS nvarchar(30)) = @codigo
    `, { codigo });
    if (rows.length) return _fmt(rows[0]);

    // Tentativa 2: campo CEAN (GTIN de caixa)
    rows = await query(`
        SELECT TOP 1
            CAST(produto AS nvarchar(300)) AS nome,
            precovenda AS preco
        FROM tabest1
        WHERE (inativo = 0 OR inativo IS NULL)
          AND CAST(CEAN AS nvarchar(30)) = @codigo
    `, { codigo });
    if (rows.length) return _fmt(rows[0]);

    // Tentativa 3: sem zeros à esquerda
    const semZero = codigo.replace(/^0+/, '');
    if (semZero && semZero !== codigo) {
        rows = await query(`
            SELECT TOP 1
                CAST(produto AS nvarchar(300)) AS nome,
                precovenda AS preco
            FROM tabest1
            WHERE (inativo = 0 OR inativo IS NULL)
              AND CAST(codigo AS nvarchar(30)) = @codigo
        `, { codigo: semZero });
        if (rows.length) return _fmt(rows[0]);
    }

    return null;
}

function _fmt(row) {
    const preco = parseFloat(row.preco || 0).toFixed(2).replace('.', ',');
    return { nome: row.nome || '', preco: `R$ ${preco}` };
}

module.exports = { buscarPrecoLocal };