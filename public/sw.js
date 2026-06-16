/* Service Worker de notificações push (Firebase Cloud Messaging). */
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js');

// Config Firebase Web (pública) — projeto compartilhado do relay
firebase.initializeApp({
    apiKey: "AIzaSyCNZROnEfmugb3f67OEczx1wvootyhda6s",
    authDomain: "terminalconsultavct.firebaseapp.com",
    projectId: "terminalconsultavct",
    storageBucket: "terminalconsultavct.firebasestorage.app",
    messagingSenderId: "167968538488",
    appId: "1:167968538488:web:e01449c18d3e160374128d"
});
const messaging = firebase.messaging();

// Faz a versão nova do SW assumir imediatamente (sem esperar fechar as abas)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Fecha todas as notificações abertas neste dispositivo
function limparNotificacoes() {
    return self.registration.getNotifications().then((ns) => ns.forEach((n) => n.close()));
}

// Push reverso: avisa o servidor para marcar tudo como lido nos demais PCs
// e limpa as notificações locais deste dispositivo.
function marcarTudoLido() {
    return Promise.all([
        fetch('/api/push/marcar-lido', { method: 'POST' }).catch(() => {}),
        limparNotificacoes()
    ]);
}

// Catálogo de frases (montado AQUI, no cliente — código aberto e transparente).
// O backend/relay só trafegam o `evento` + campos estruturados e sanitizados; a
// redação exibida vive neste arquivo. Cada entrada devolve { title, body } e, se
// fizer sentido, `imprimir: true` para habilitar o botão de impressão.
const EVENTOS = {
    leitor_desconectado: (d) => ({
        title: 'Leitor desconectado',
        body: `${d.nome || 'Leitor'} ${d.motivo === 'queda' ? 'caiu (queda brusca).' : 'saiu do ar.'}`
    }),
    produto_nao_encontrado: (d) => ({
        title: 'Produto não encontrado',
        body: `Código ${d.codigo} em ${d.terminal || 'terminal'}`
    }),
    produto_frequente: (d) => ({
        title: 'Produto muito buscado',
        body: `${d.nome || 'Produto'} já foi consultado ${d.n}x`,
        imprimir: true
    }),
    teste: () => ({
        title: 'GERTEC — Teste',
        body: 'Notificações funcionando! 🎉'
    })
};

// Monta as opções da notificação a partir do `evento` + campos (data-only).
// Toda notificação ganha o botão "Marcar como lido". Eventos `imprimir` com um
// código ganham o botão "Imprimir preço" lado a lado.
function montarNotificacao(d) {
    const fab = EVENTOS[d.evento];
    const msg = fab ? fab(d) : { title: 'GERTEC', body: '' };

    const opts = {
        body: msg.body || '',
        icon: '/res/icons/icon_x512.png',
        badge: '/res/icons/maskable_icon_x96.png',
        data: d
    };
    const actions = [];
    if (msg.imprimir && d.codigo) {
        actions.push({ action: 'imprimir', title: '🖨️ Imprimir preço' });
        opts.requireInteraction = true;
    }
    actions.push({ action: 'lido', title: '✓ Marcar como lido' });
    opts.actions = actions;
    return [msg.title || 'GERTEC', opts];
}

// Trata um `data` de notificação: ou limpa (push reverso) ou exibe.
// Fonte única usada tanto no segundo plano quanto no primeiro plano (via postMessage).
function exibirOuLimpar(d) {
    // Push reverso "limpar": só fecha as notificações, não exibe nada
    if (d.evento === 'limpar') return limparNotificacoes();
    const [titulo, opts] = montarNotificacao(d);
    return self.registration.showNotification(titulo, opts);
}

// Mensagens recebidas com a aba fechada / em segundo plano
messaging.onBackgroundMessage((payload) => exibirOuLimpar(payload.data || {}));

// Mensagens recebidas com a aba EM FOCO: o FCM entrega na página, que apenas
// repassa o `data` pra cá. Assim a lógica de montar/exibir vive só no SW.
self.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'fcm-foreground') event.waitUntil(exibirOuLimpar(msg.data || {}));
});

self.addEventListener('notificationclick', (event) => {
    const d = event.notification.data || {};
    event.notification.close();

    // Botão "Marcar como lido" → limpa em todos os PCs (push reverso)
    if (event.action === 'lido') {
        event.waitUntil(marcarTudoLido());
        return;
    }

    // Botão "Imprimir preço" → imprime e também marca como lido nos demais PCs
    if (event.action === 'imprimir' && d.codigo) {
        event.waitUntil(Promise.all([
            fetch('/api/imprimir-preco', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codigo: d.codigo, id: d.id })
            }).catch(() => {}),
            marcarTudoLido()
        ]));
        return;
    }

    // Clique no corpo → foca/abre o painel
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            for (const w of wins) { if ('focus' in w) return w.focus(); }
            if (clients.openWindow) return clients.openWindow('/');
        })
    );
});
