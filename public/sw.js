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

// Monta as opções da notificação a partir do `data` (mensagens data-only).
// Toda notificação ganha o botão "Marcar como lido". Se vier `acao=imprimir`
// com um código, o botão "Imprimir preço" fica lado a lado.
function montarNotificacao(d) {
    const opts = {
        body: d.body || '',
        icon: '/res/icons/icon_x512.png',
        badge: '/res/icons/maskable_icon_x96.png',
        data: d
    };
    const actions = [];
    if (d.acao === 'imprimir' && d.codigo) {
        actions.push({ action: 'imprimir', title: '🖨️ Imprimir preço' });
        opts.requireInteraction = true;
    }
    actions.push({ action: 'lido', title: '✓ Marcar como lido' });
    opts.actions = actions;
    return [d.title || 'GERTEC', opts];
}

// Mensagens recebidas com a aba fechada / em segundo plano
messaging.onBackgroundMessage((payload) => {
    const d = payload.data || {};
    // Push reverso "limpar": só fecha as notificações, não exibe nada
    if (d.acao === 'limpar') {
        limparNotificacoes();
        return;
    }
    const [titulo, opts] = montarNotificacao(d);
    self.registration.showNotification(titulo, opts);
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
