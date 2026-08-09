/* Service Worker de notificações push (Firebase Cloud Messaging).
 */
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js');

// Config Firebase Web (pública) — mesmo projeto que emite os tokens (sicprinter),
// para que o serviço unificado consiga entregar.
firebase.initializeApp({
    apiKey: "AIzaSyB0qYB1_PGQKPPbC377IyczcbLG8vsNsMQ",
    authDomain: "sicprinter.firebaseapp.com",
    projectId: "sicprinter",
    storageBucket: "sicprinter.firebasestorage.app",
    messagingSenderId: "186361915401",
    appId: "1:186361915401:web:7e33f088960bff7df470d8",
    measurementId: "G-G53F0Q3416"
});
const messaging = firebase.messaging();

// Faz a versão nova do SW assumir imediatamente (sem esperar fechar as abas)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Fecha notificações abertas neste dispositivo. Com `tag`, fecha SÓ a notificação
// correspondente (limpeza direcionada); sem `tag`, fecha todas ("marcar tudo como lido").
function limparNotificacoes(tag) {
    const filtro = tag ? { tag: String(tag) } : undefined;
    return self.registration.getNotifications(filtro).then((ns) => ns.forEach((n) => n.close()));
}

// Push reverso: avisa o servidor para marcar tudo como lido nos demais PCs
// e limpa as notificações locais deste dispositivo.
function marcarTudoLido() {
    return Promise.all([
        fetch('/api/push/marcar-lido', { method: 'POST' }).catch(() => {}),
        limparNotificacoes()
    ]);
}

// Espelha o catálogo do servidor (disparar.js): no 1º PLANO o MessagePayload do
// FCM (onMessage) NÃO traz o bloco webpush.notification — logo perde `actions` e
// `requireInteraction`. Reconstruímos os botões a partir de `evento`/`codigo`:
//  • EVENTOS_IMPRIMIR  → ganham "Imprimir preço" (lá: `imprimir: true`, exige codigo)
//  • EVENTOS_FIXAR     → persistentes (lá: `requireInteraction: true`)
// Todo evento exibido ganha "Marcar como lido" (igual ao buildActions do servidor).
const EVENTOS_IMPRIMIR = new Set(['produto_frequente']);
const EVENTOS_FIXAR    = new Set(['produto_frequente', 'etiqueta_ligada']);

function montarActions(data) {
    const actions = [];
    if (EVENTOS_IMPRIMIR.has(data.evento) && data.codigo) {
        actions.push({ action: 'imprimir', title: '🖨️ Imprimir preço' });
    }
    actions.push({ action: 'lido', title: '✓ Marcar como lido' });
    return actions;
}

// Exibe um payload já RENDERIZADO pelo servidor. Usado no PRIMEIRO PLANO (a página
// repassa o payload, pois nesse caso o FCM não exibe sozinho). O comando `limpar`
// é data-only: só fecha notificações, não exibe nada.
function exibirPayload(payload) {
    const data = (payload && payload.data) || {};
    if (data.evento === 'limpar') return limparNotificacoes(data.id);

    // O conteúdo vem pronto: prioriza o bloco webpush.notification do servidor; no
    // 1º plano ele não vem, então reconstruímos botões/persistência a partir do data.
    const wn = (payload.webpush && payload.webpush.notification) || {};
    const n  = payload.notification || {};
    const opts = {
        body: wn.body || n.body || '',
        icon: wn.icon || '/res/icons/icon_x512.png',
        badge: wn.badge || '/res/icons/maskable_icon_x96.png',
        data,
        actions: (Array.isArray(wn.actions) && wn.actions.length) ? wn.actions : montarActions(data),
        requireInteraction: wn.requireInteraction != null ? !!wn.requireInteraction : EVENTOS_FIXAR.has(data.evento),
    };
    if (wn.tag || data.id) opts.tag = String(wn.tag || data.id);
    return self.registration.showNotification(wn.title || n.title || 'GERTEC', opts);
}

// SEGUNDO PLANO: para eventos renderizados, o navegador exibe a partir do bloco
// `notification`/`webpush.notification` — não exibimos de novo (evita duplicar).
// Só tratamos aqui o `limpar` (data-only, que o navegador não exibe).
messaging.onBackgroundMessage((payload) => {
    const data = (payload && payload.data) || {};
    if (data.evento === 'limpar') return limparNotificacoes(data.id);
});

// PRIMEIRO PLANO (aba em foco): o FCM entrega na página, que repassa o payload
// inteiro pra cá. Assim a exibição vive só no SW.
self.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'fcm-foreground') event.waitUntil(exibirPayload(msg.payload || {}));
});

self.addEventListener('notificationclick', (event) => {
    // No 1º plano nós exibimos (exibirPayload) com `data` PLANO. No 2º plano quem
    // exibe é o SDK do FCM, que aninha tudo em data.FCM_MSG.{notification,data} —
    // então `codigo`/`id`/`evento` ficam em data.FCM_MSG.data, não no topo.
    const raw = event.notification.data || {};
    const d = raw.FCM_MSG ? (raw.FCM_MSG.data || {}) : raw;
    event.notification.close();

    // Botão "Marcar como lido" → limpa em todos os PCs (push reverso)
    if (event.action === 'lido') {
        event.waitUntil(marcarTudoLido());
        return;
    }

    // Botão "Imprimir preço" → imprime e limpa SOMENTE este item. A notificação
    // clicada já foi fechada acima; o /api/imprimir-preco dispara o push reverso
    // direcionado (por `id`) que fecha a mesma notificação nos demais PCs.
    if (event.action === 'imprimir' && d.codigo) {
        event.waitUntil(
            fetch('/api/imprimir-preco', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codigo: d.codigo, id: d.id, origem: 'terminal' })
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
