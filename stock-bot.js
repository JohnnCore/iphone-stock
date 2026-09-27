#!/usr/bin/env node
// Vigia o stock do iPhone 18 Pro Max (Bordô, Glaciar, Prateado e Preto, 256 GB por omissão) na Vodafone PT
// e avisa quando cada variante ficar "Em stock".
//
// Uso:   node stock-bot.js            (corre em loop)
//        node stock-bot.js --once     (uma verificação e sai)
//        node stock-bot.js --test     (envia uma notificação de teste)
//
// Notificações (todas opcionais, além do terminal):
//   NTFY_TOPIC=o-teu-topico        -> push para o telemóvel via https://ntfy.sh (app ntfy)
//   TELEGRAM_TOKEN + TELEGRAM_CHAT -> mensagem Telegram
//   DISCORD_WEBHOOK_URL            -> mensagem num canal do Discord via webhook
//   Em WSL mostra também um toast do Windows.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Carrega .env (se existir, ao lado deste ficheiro) sem depender de pacotes externos.
// Variáveis já definidas no ambiente (ex: docker-compose env_file) têm sempre prioridade.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let val = (m[2] ?? '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PAGE_PATH = '/loja/telemoveis/apple/iphone-18-pro-max-5g.html';
const PAGE_URL = `https://www.vodafone.pt${PAGE_PATH}?segment=consumer&paymentType=pvp`;
const API_URL = `https://www.vodafone.pt/bin/mvc.do/eshop/products/productDetails?pageModel=${encodeURIComponent(PAGE_PATH)}`;
// Cores separadas por vírgula, tal como aparecem no site (ex: TARGET_COLORS="Glaciar,Prateado,Preto,Bordô").
const TARGET_STORAGE = process.env.TARGET_STORAGE || '256 GB';
const TARGET_COLORS = (process.env.TARGET_COLORS || process.env.TARGET_COLOR || 'Bordô,Glaciar,Prateado,Preto')
  .split(',').map((c) => c.trim()).filter(Boolean);
const TARGETS = TARGET_COLORS.map((color) => ({ color, storage: TARGET_STORAGE, label: `${color} ${TARGET_STORAGE}` }));

// Link direto para a variante ("256 GB" -> storage=256, "2 TB" -> storage=2).
const variantUrl = (t) =>
  `${PAGE_URL}&color=${encodeURIComponent(t.color.toLowerCase())}&storage=${parseInt(t.storage, 10)}`;

const INTERVAL_MS = (Number(process.env.INTERVAL_SECONDS) || 60) * 1000;
// User-Agents de browsers reais; um é escolhido ao acaso em cada pedido.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
];
// Um UA por execução: trocar de browser a cada pedido, a partir do mesmo IP, é mais suspeito do que manter um.
const USER_AGENT = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const log = (...a) => console.log(`[${new Date().toLocaleString('pt-PT')}]`, ...a);

// O site devolve o stock como string em formato PT ("0", "11.000").
const parseStock = (s) => Number(String(s ?? '0').replace(/\./g, '').replace(',', '.')) || 0;

const REQUEST_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A API da Vodafone às vezes demora ou fica sem responder; tenta até MAX_ATTEMPTS vezes antes de desistir do ciclo.
async function fetchProduct() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(API_URL, requestOptions());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        log(`Tentativa ${attempt}/${MAX_ATTEMPTS} falhou (${e.message}); a repetir...`);
        await sleep(3000 * attempt);
      }
    }
  }
  throw lastErr;
}

const requestOptions = () => ({
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
    Referer: PAGE_URL,
    'Content-Type': 'application/json;charset=utf-8',
    'Process-Id': 'eshop/products',
  },
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

async function checkStock() {
  const body = await fetchProduct();
  const variants = body?.productModel?.variants;
  if (!Array.isArray(variants)) throw new Error('Resposta inesperada (sem variants)');
  return TARGETS.map((t) => {
    const v = variants.find((x) => x.color === t.color && x.storage === t.storage);
    if (!v) return { target: t, error: `Variante ${t.label} não encontrada` };
    return { target: t, inStock: parseStock(v.stock) > 0, raw: v.stock, title: body.productModel.title };
  });
}

// fetch não rejeita em respostas 4xx/5xx, por isso confirmamos o status aqui
// para que um webhook inválido, por exemplo, apareça nos logs como falha.
async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url.split('/')[2]} respondeu HTTP ${res.status}`);
}

async function notify(title, message, url = PAGE_URL) {
  process.stdout.write('\x07'); // bell
  log(`🔔 ${title} — ${message}`);
  const jobs = [];

  if (process.env.NTFY_TOPIC) {
    jobs.push((async () => {
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
        method: 'POST',
        headers: { Title: encodeURIComponent(title), Click: url, Priority: 'urgent', Tags: 'iphone', 'Content-Type': 'text/plain; charset=utf-8' },
        body: message,
      });
      if (!res.ok) throw new Error(`ntfy respondeu HTTP ${res.status}`);
    })());
  }
  if (process.env.DISCORD_WEBHOOK_URL) {
    // DISCORD_USER_ID = o teu ID numérico do Discord (Modo de Programador -> Copiar ID do Utilizador).
    // Só <@ID> gera uma menção real (som/notificação); escrever "@Nome" como texto não notifica ninguém.
    const mention = process.env.DISCORD_USER_ID ? `<@${process.env.DISCORD_USER_ID}> ` : '';
    jobs.push(postJSON(process.env.DISCORD_WEBHOOK_URL, {
      content: `${mention}**${title}**\n${message}\n${url}`,
      allowed_mentions: { parse: ['users'] },
    }));
  }
  if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT) {
    jobs.push(postJSON(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT,
      text: `${title}\n${message}\n${url}`,
    }));
  }
  if (process.env.WSL_DISTRO_NAME) {
    const ps = `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];` +
      `$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02');` +
      `$n=$t.GetElementsByTagName('text');$n.Item(0).AppendChild($t.CreateTextNode('${title}'))|Out-Null;` +
      `$n.Item(1).AppendChild($t.CreateTextNode('${message}'))|Out-Null;` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Vodafone Stock Bot').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    jobs.push(new Promise((r) => execFile('powershell.exe', ['-NoProfile', '-Command', ps], () => r())));
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') log('Falha ao notificar:', r.reason?.message ?? r.reason);
  }
}

async function main() {
  if (process.argv.includes('--test')) return notify('Teste', 'O bot de stock está a funcionar.');
  const once = process.argv.includes('--once');
  const last = new Map(); // label -> último estado conhecido (true/false); ausente = sem leitura válida
  let errors = 0;

  log(`A vigiar ${TARGETS.map((t) => t.label).join(', ')} a cada ${INTERVAL_MS / 1000}s...`);
  for (;;) {
    try {
      const results = await checkStock();
      errors = 0;
      for (const r of results) {
        const { label } = r.target;
        if (r.error) {
          log(`⚠️  ${label}: ${r.error}`);
          continue;
        }
        log(`${r.inStock ? '✅ Em stock' : '❌ Sem stock'} — ${label}${r.inStock ? ` (${r.raw})` : ''}`);
        // Alerta na transição Sem stock -> Em stock (e também se já estiver em stock no arranque).
        if (r.inStock && last.get(label) !== true) {
          await notify(`${r.title} em stock!`, `${label} já está disponível na Vodafone.`, variantUrl(r.target));
        }
        last.set(label, r.inStock);
      }
    } catch (e) {
      errors++;
      log(`Erro (${errors}): ${e.message}`);
      if (errors === 10) await notify('Stock bot com problemas', `10 falhas seguidas: ${e.message}`);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, INTERVAL_MS + Math.random() * 5000)); // jitter
  }
}

main();
