<h1>Utilitário Gertec para SIC6</h1>

<p>
Este utilitário permite integrar terminais de consulta de preço da Gertec, como TC506 Mídia e Busca Preço G2, diretamente ao SIC6.
</p>

<p>
A integração é feita por meio de conexão direta com o banco de dados SQL utilizado pelo SIC6. Recomenda-se utilizar um usuário com permissão apenas de leitura.
</p>

<p>
Devido às diversas variações dos equipamentos Busca Preço da Gertec, não é possível garantir compatibilidade com todos os modelos.
</p>

<h2>Funcionalidades</h2>

<ul>
  <li>Consulta de preços diretamente no banco do SIC6</li>
  <li>Envio de mídias para os terminais</li>
  <li>Configuração de playlists nos dispositivos</li>
  <li>Integração com APIs externas de consulta de preço (opcional)</li>
</ul>

<h2>Como utilizar</h2>

<h3>1. Instalação</h3>

<p>Instale o Node.js e execute:</p>

<pre><code>npm install</code></pre>

<p>Isso instalará automaticamente todas as dependências necessárias do projeto.</p>

<h3>2. Configuração do ambiente</h3>

<p>Crie um arquivo <code>.env</code> na raiz do projeto com as seguintes configurações:</p>

<pre><code># SQL Server
DB_SERVER=IP_DO_SERVIDOR
DB_PORT=PORTA_DO_SQL
DB_DATABASE=NOME_DO_BANCO
DB_USER=USUARIO
DB_PASSWORD=SENHA

# Servidor
PORT=3102

# Integração opcional
IMPRESSORA_URL=URL_DA_API_DE_IMPRESSAO
</code></pre>

<p>Caso utilize a API de impressão, ajuste também o endpoint e não se esqueça de modificar no HTML:</p>

<pre><code>/api/v1/imprimir/preco</code></pre>

<h3>3. Execução</h3>

<p>Para manter o serviço em execução contínua, utilize ferramentas como:</p>

<ul>
  <li>pm2</li>
  <li>nssm (Windows)</li>
</ul>

<h2>Observações</h2>

<ul>
  <li>Não há qualquer vínculo com o SIC6 ou SICNET.</li>
  <li>Antes de utilizar qualquer software, verifique a procedência.</li>
  <li>Recomenda-se utilizar um usuário de banco com permissão apenas de leitura.</li>
  <li>O uso da ferramenta é de responsabilidade do usuário. Cuidado com o que você conecta ao seu SQL.</li>
  <li>Você pode modificar o projeto livremente, mas lembre-se de nos referneciar :D</li>
</ul>
