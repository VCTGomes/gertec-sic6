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

// Monta as opções da notificação a partir do `data` (mensagens data-only).
// Se vier `acao=imprimir` com um código, adiciona o botão "Imprimir preço".
function montarNotificacao(d) {
    const opts = {
        body: d.body || '',
        icon: '/res/icons/icon_x512.png',
        badge: '/res/icons/maskable_icon_x96.png',
        data: d
    };
    if (d.acao === 'imprimir' && d.codigo) {
        opts.actions = [{ action: 'imprimir', title: '🖨️ Imprimir preço' }];
        opts.requireInteraction = true;
    }
    return [d.title || 'GERTEC', opts];
}

// Mensagens recebidas com a aba fechada / em segundo plano
messaging.onBackgroundMessage((payload) => {
    const [titulo, opts] = montarNotificacao(payload.data || {});
    self.registration.showNotification(titulo, opts);
});

self.addEventListener('notificationclick', (event) => {
    const d = event.notification.data || {};
    event.notification.close();

    // Botão "Imprimir preço" → chama a API de impressão do app (mesma origem)
    if (event.action === 'imprimir' && d.codigo) {
        event.waitUntil(
            fetch('/api/imprimir-preco', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codigo: d.codigo, id: d.id })
            }).catch(() => {})
        );
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
