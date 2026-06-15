const path = require('path');
const fs   = require('fs');

const configPath = path.join(__dirname, '..', 'data', 'config.json');

function lerConfig() {
    const defaults = {
        PORT_BP: parseInt(process.env.PORT_BP) || 6500,
        PORT_TC: parseInt(process.env.PORT_TC) || 16510,
        IMPRESSORA_URL: process.env.IMPRESSORA_URL || '',
        PUSH_BUSCAS_LIMITE: parseInt(process.env.PUSH_BUSCAS_LIMITE) || 10,
        APELIDOS: {}
    };
    try {
        if (fs.existsSync(configPath)) {
            return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
        }
    } catch (e) {}
    return defaults;
}

module.exports = { lerConfig, configPath };
