# GERTEC Relay

Relay de notificações push via **Firebase Cloud Messaging (FCM)**.

O relay é **stateless**: ele guarda apenas a credencial do Google (service account, na sua
Oracle) e **encaminha** o push pro FCM. Quem armazena os tokens dos dispositivos é o **app
GERTEC** (na máquina de cada instalação), que envia os tokens-alvo no corpo do `/notify`.

```
App GERTEC ──POST /notify (Bearer RELAY_SECRET) { tokens, title, body }──▶ Relay (Oracle) ──FCM──▶ navegadores/PWA
```

## Endpoints

| Método | Rota       | Auth          | Descrição                                                  |
|--------|------------|---------------|------------------------------------------------------------|
| GET    | `/health`  | —             | Status do serviço                                          |
| POST   | `/notify`  | Bearer secret | `{ tokens, title, body, data }` — encaminha o push pro FCM |

O `/notify` devolve `{ enviados, falhas, invalidos }`. O array `invalidos` lista os tokens
que o FCM rejeitou (expirados/inexistentes) para o app removê-los do seu armazenamento.

## Deploy na Oracle Linux

```bash
sudo mkdir -p /opt/gertec-relay && cd /opt/gertec-relay
# copie os arquivos do relay para cá (git clone / scp)

npm install --omit=dev

# segredos (não versionados)
mkdir -p certs
cp /caminho/firebase-sa.json certs/firebase-sa.json   # baixado do console Firebase
cp .env.example .env
nano .env                                             # defina RELAY_SECRET etc.

# usuário de serviço + permissões
sudo useradd -r -s /usr/sbin/nologin gertec || true
sudo chown -R gertec:gertec /opt/gertec-relay

# systemd
sudo cp gertec-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gertec-relay
sudo systemctl status gertec-relay
```

### Firewall da Oracle (importante)

A Oracle bloqueia portas por padrão em **dois** lugares:

1. **Security List / NSG** no painel da VCN — libere a porta TCP (ex.: 8787).
2. **iptables/firewalld** dentro da instância:

```bash
sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload
# ou, em imagens com iptables puro:
sudo iptables -I INPUT 5 -p tcp --dport 8787 -j ACCEPT
```

> Recomendado: coloque o relay atrás de um Nginx com HTTPS (Let's Encrypt) e deixe o
> Node ouvindo só em `127.0.0.1`. Web Push exige HTTPS no front de qualquer forma.

## Auto-deploy (self-updater)

O `updater.js` escuta um webhook do GitHub (`POST /webhook`, porta 9001) e, a cada push,
faz `git reset --hard origin/main`, `npm install` e `systemctl restart gertec-relay`.
Os segredos (`certs/`, `.env`) são ignorados pelo git e **preservados** no `git clean -fd`.

```bash
sudo cp gertec-relay-updater.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gertec-relay-updater
```

No GitHub (repo `gertec-sic6-push`) → **Settings ▸ Webhooks ▸ Add webhook**:
- Payload URL: `https://SEU_HOST:9001/webhook`
- Content type: `application/json`
- Secret: o mesmo `WEBHOOK_UPDATER_SECRET` do `.env`
- Eventos: apenas `push`

> Abra a porta 9001 na Security List da Oracle e no firewall, igual à porta do relay.

## Teste rápido

```bash
curl -s localhost:8787/health
curl -s -X POST localhost:8787/notify \
  -H "Authorization: Bearer SEU_RELAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tokens":["TOKEN_FCM_DO_NAVEGADOR"],"title":"Teste","body":"Funcionou!"}'
```
