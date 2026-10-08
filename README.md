# Agendamento – Design de Cílios

A **dona libera cada semana** no painel (`/admin`), escolhendo os dias de atendimento, os **horários** de cada dia e as **vagas** de cada horário. As clientes só enxergam semanas liberadas: escolhem o dia, o horário e o modelo do cílio, informam nome e WhatsApp e confirmam.

A confirmação acontece em **duas etapas**:

1. **Cliente pede o horário.** O pedido fica **pendente** e **ainda não ocupa vaga**. A cliente vê um botão **"Enviar mensagem no WhatsApp"** (link `wa.me`) que abre a conversa com a dona já com a mensagem pronta.
2. **Dona confirma no painel.** Em `/admin`, clica em **Confirmar** (aí sim o horário sai da agenda) ou em **Recusar**. Nos dois casos abre o WhatsApp da cliente com a resposta pronta.

Vários pedidos podem chegar para o mesmo horário (até 5 pendentes por horário). A dona escolhe quem confirmar. Se o horário lotar, o botão Confirmar dos demais fica desativado e ela recusa.

```
Olá! Acabei de solicitar um design de cílios pelo site. 💖

Nome: Maria Silva
Dia: quarta-feira, 14/10/2026
Horário: 14:00
Modelo: Volume russo

Pode confirmar, por favor?
```

O envio é feito pela própria cliente, no WhatsApp dela. Não é preciso conta de API nem custo de mensagens.

## Catálogo, valores e fotos (`catalog.json`)

Tudo o que aparece no site (nome, textos do "Sobre", serviços, descrições, valores de aplicação/manutenção, adicionais e fotos) fica em `catalog.json`. É só editar e salvar: o servidor relê o arquivo sozinho.

- Serviço só com aplicação: deixe só `"aplicacao"` em `prices` (como os designs de sobrancelha).
- Fotos ficam em `public/img/`. Uma foto pode ser `"img/x.jpg"` ou `{ "src": "img/x.jpg", "focus": "70% 50%" }`. O `focus` diz qual parte da foto aparece no corte do card (horizontal, vertical).
- Depois de adicionar ou trocar fotos, rode `npm run thumbs`. Ele gera as miniaturas leves (`public/img/thumbs/`) usadas na faixa "Trabalhos reais" e na escolha do serviço. Se esquecer, o site usa a foto original, só que mais pesada.
- O pedido da cliente leva serviço, tipo, adicionais e valor total. Tudo vai na mensagem do WhatsApp e aparece no painel.

## Notificações de novo pedido (Web Push)

A dona recebe um aviso no celular ou no computador a cada novo pedido, **mesmo com o painel fechado**. Tocar no aviso abre a aba Pedidos.

- **Ativar:** no painel, toque em **Notificações** (ou no aviso do Início) e em **Ativar notificações**. Faça isso em cada aparelho.
- **iPhone (iOS 16.4+):** só funciona com o painel instalado como app. No Safari, abra `/admin`, toque em **Compartilhar › Adicionar à Tela de Início**, abra o app **Agenda** e ative por lá. O painel mostra esse passo a passo quando aberto no iPhone.
- **Android/computador:** funciona direto no Chrome ou no Edge. Também dá para instalar como app pelo menu do navegador.
- **Requisito:** o site precisa estar publicado com **HTTPS**. Em `localhost` funciona só no próprio computador, para teste. No celular é preciso o endereço público em https.
- As chaves ficam em `data/vapid.json` e os aparelhos inscritos em `data/push-subscriptions.json`. Guarde junto com o backup da pasta `data`: se as chaves mudarem, é preciso ativar de novo em cada aparelho.
- Defina `VAPID_SUBJECT` no `.env` com um e-mail seu (`mailto:...`). A Apple exige.
- O ícone do app mostra o número de pedidos pendentes (iPhone e Android com o app instalado).
- Para trocar os ícones do app, edite e rode `node scripts/icons.js`.

## Rodar

```bash
npm install
copy .env.example .env    # Windows (Mac/Linux: cp .env.example .env) e ajuste os valores
npm start
```

- Site das clientes: http://localhost:3000
- Painel da dona: http://localhost:3000/admin (use a `ADMIN_KEY` do `.env`)

Requer Node 18+. Os dados ficam em `data/bookings.json` (faça backup dessa pasta).

## Como a dona usa o painel

1. Entre em `/admin` com a chave.
2. Escolha a semana nas setas.
3. Ligue "Atendo neste dia", defina horários e vagas (use "Copiar estes horários para os outros dias abertos" para ganhar tempo).
4. Clique em **Salvar e liberar semana**. Para esconder a semana, **Tirar semana do ar**.
5. Na lista da semana aparecem todos os pedidos com a situação (**Pendente**, **Confirmado**, **Recusado**). Em cada pendente: **Confirmar** ou **Recusar**. O WhatsApp da cliente abre com a mensagem pronta.

Regras: não dá para remover um horário que já tem agendamento confirmado, nem reduzir as vagas abaixo do que já foi confirmado. A mesma pessoa (mesmo telefone) só pode ter um pedido ativo (pendente ou confirmado) por dia. Agendamentos antigos, de antes desta mudança, contam como confirmados.

## Configuração (.env)

| Variável | O que faz |
|---|---|
| `OWNER_PHONE` | WhatsApp da dona (destino da mensagem pronta) |
| `ADMIN_KEY` | Senha do painel da dona |
| `MAX_WEEKS_AHEAD` | Quantas semanas à frente a dona pode liberar |

## API

- `GET /api/config` – catálogo (dados do estúdio, serviços, adicionais).
- `GET /api/availability?week=YYYY-MM-DD` – semanas liberadas: dias, horários e vagas restantes.
- `POST /api/bookings` – `{ name, phone, date, time, serviceId, option: "aplicacao"|"manutencao", extras: [ids] }`. Cria um pedido `pending` e retorna `whatsappLink` e `message`. 409 se o horário lotou, se tem pedidos pendentes demais ou se o mesmo telefone já pediu naquele dia.
- `GET /api/admin/weeks/:week` / `PUT /api/admin/weeks/:week` – ler e salvar/liberar uma semana (header `x-admin-key`).
- `GET /api/admin/bookings?status=pending|confirmed|rejected|cancelled` – lista completa, com filtro opcional (header `x-admin-key`).
- `POST /api/admin/bookings/:id/cancel` – cancela um agendamento confirmado; a vaga volta para a agenda.
- `DELETE /api/admin/weeks/:week/bookings` – `{ confirm: "LIMPAR", expected: <qtd> }`. Apaga todos os agendamentos da semana (cópia em `data/removed-bookings.json`). 409 se a quantidade mudou desde que a dona abriu a tela.
- `POST /api/admin/bookings/:id/confirm` / `POST /api/admin/bookings/:id/reject` – a dona responde o pedido. Retorna `whatsappLink` para avisar a cliente. 409 se já foi respondido ou se o horário lotou, foi removido ou já passou.
