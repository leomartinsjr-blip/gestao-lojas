'use strict';
const { fetchClientes } = require('./microvix');

// ── Helpers ────────────────────────────────────────────────────────────────
function getLojas() {
  try { return JSON.parse(process.env.MICROVIX_LOJAS || '{}'); } catch { return {}; }
}

function brtNow() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function pad(n) { return String(n).padStart(2, '0'); }

function parseBirthDay(s) {
  if (!s) return '';
  const m = s.match(/^(\d{2})\/(\d{2})/);           // DD/MM/YYYY
  if (m) return `${m[1]}/${m[2]}`;
  const m2 = s.match(/^\d{4}-(\d{2})-(\d{2})/);     // YYYY-MM-DD
  if (m2) return `${m2[2]}/${m2[1]}`;
  return '';
}

function applyTemplate(template, vars) {
  return (template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Z-API WhatsApp sender ──────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const { ZAPI_INSTANCE_ID: inst, ZAPI_TOKEN: tok, ZAPI_CLIENT_TOKEN: ct } = process.env;
  if (!inst || !tok || !ct) throw new Error('Z-API não configurado (ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN)');

  let num = phone.replace(/\D/g, '');
  if (!num) throw new Error('Número de telefone inválido');
  if (!num.startsWith('55')) num = '55' + num;

  const r = await fetch(`https://api.z-api.io/instances/${inst}/token/${tok}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': ct },
    body: JSON.stringify({ phone: num, message }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Z-API ${r.status}: ${txt}`);
  return JSON.parse(txt);
}

// ── Customer sync from Microvix ────────────────────────────────────────────
async function syncCustomers(mongoDb) {
  const lojas = getLojas();
  const entries = Object.entries(lojas);
  if (!entries.length) throw new Error('MICROVIX_LOJAS não configurado');

  const col = mongoDb.collection('crm_customers');
  let total = 0;

  for (const [board, cnpj] of entries) {
    const chave = process.env[`MICROVIX_CHAVE_${board.toUpperCase()}`] || process.env.MICROVIX_CHAVE;
    try {
      const rows = await fetchClientes(cnpj.replace(/\D/g, ''), chave);
      for (const row of rows) {
        // Campos conforme documentação LinxClientesFornec v262
        const nome  = (row.nome_cliente || row.razao_cliente || '').trim();
        const phone = (row.cel_cliente  || row.fone_cliente  || '').replace(/\D/g, '');
        const cpf   = (row.doc_cliente  || '').replace(/\D/g, '');
        const id    = cpf || phone;
        if (!id || !nome) continue;

        const dtNasc = parseBirthDay(row.data_nascimento || '');

        await col.updateOne(
          { _id: id },
          {
            $set: {
              nome,
              celular:    phone,
              email:      (row.email_cliente || '').trim(),
              dtNasc,
              dtNascFull: row.dt_nasc || row.data_nascimento || row.dt_nascimento || '',
              cpf:        cpf || '',
              syncedAt:   new Date(),
            },
            $addToSet:    { lojas: board },
            $setOnInsert: { criadoEm: new Date(), ultimaCompra: null, reengagementSentAt: null },
          },
          { upsert: true }
        );
        total++;
      }
      console.log(`[CRM] ${board}: ${rows.length} clientes sincronizados`);
    } catch (e) {
      console.warn(`[CRM] Falha ao sincronizar clientes de ${board}: ${e.message}`);
    }
  }
  return total;
}

// ── Log message ────────────────────────────────────────────────────────────
async function logMessage(mongoDb, customer, campaign, mensagem, status, erro = '') {
  await mongoDb.collection('crm_messages').insertOne({
    customerId:    customer._id,
    customerNome:  customer.nome,
    celular:       customer.celular,
    campaignId:    String(campaign._id),
    campaignNome:  campaign.nome,
    mensagem,
    status,
    erro,
    enviadoEm:     new Date(),
  });
}

// ── Birthday campaigns ─────────────────────────────────────────────────────
async function runBirthdayCampaigns(mongoDb) {
  const campaigns = await mongoDb.collection('crm_campaigns')
    .find({ tipo: 'birthday', ativo: true }).toArray();
  if (!campaigns.length) return 0;

  const brt = brtNow();
  const todayDDMM = `${pad(brt.getUTCDate())}/${pad(brt.getUTCMonth() + 1)}`;
  const todayStr  = brt.toISOString().slice(0, 10);

  const customers = await mongoDb.collection('crm_customers')
    .find({ dtNasc: todayDDMM, celular: { $nin: ['', null] } }).toArray();

  let sent = 0;
  for (const campaign of campaigns) {
    for (const customer of customers) {
      const alreadySent = await mongoDb.collection('crm_messages').findOne({
        customerId:  customer._id,
        campaignId:  String(campaign._id),
        enviadoEm:   { $gte: new Date(todayStr) },
      });
      if (alreadySent) continue;

      const firstName = customer.nome.split(' ')[0];
      const msg = applyTemplate(campaign.template, {
        nome: firstName, nomeCompleto: customer.nome,
      });
      try {
        await sendWhatsApp(customer.celular, msg);
        await logMessage(mongoDb, customer, campaign, msg, 'sent');
        sent++;
      } catch (e) {
        await logMessage(mongoDb, customer, campaign, msg, 'failed', e.message);
      }
      await delay(1200);
    }
  }
  return sent;
}

// ── Reengagement campaigns ─────────────────────────────────────────────────
async function runReengagementCampaigns(mongoDb) {
  const campaigns = await mongoDb.collection('crm_campaigns')
    .find({ tipo: 'reengagement', ativo: true }).toArray();
  if (!campaigns.length) return 0;

  let sent = 0;
  for (const campaign of campaigns) {
    const dias    = campaign.config?.diasSemCompra || 60;
    const cutoff  = new Date(Date.now() - dias * 86400_000);
    const cooldown = new Date(Date.now() - dias * 86400_000);

    const customers = await mongoDb.collection('crm_customers').find({
      ultimaCompra: { $lt: cutoff, $ne: null },
      celular:      { $nin: ['', null] },
      $or: [{ reengagementSentAt: null }, { reengagementSentAt: { $lt: cooldown } }],
    }).limit(50).toArray();

    for (const customer of customers) {
      const diasSemCompra = Math.floor((Date.now() - new Date(customer.ultimaCompra)) / 86400_000);
      const firstName = customer.nome.split(' ')[0];
      const msg = applyTemplate(campaign.template, {
        nome: firstName, nomeCompleto: customer.nome,
        dias: String(diasSemCompra), loja: customer.lojas?.[0] || 'nós',
      });
      try {
        await sendWhatsApp(customer.celular, msg);
        await logMessage(mongoDb, customer, campaign, msg, 'sent');
        await mongoDb.collection('crm_customers').updateOne(
          { _id: customer._id }, { $set: { reengagementSentAt: new Date() } }
        );
        sent++;
      } catch (e) {
        await logMessage(mongoDb, customer, campaign, msg, 'failed', e.message);
      }
      await delay(1200);
    }
  }
  return sent;
}

// ── Run all automated campaigns ────────────────────────────────────────────
async function runScheduledCampaigns(mongoDb) {
  const [b, r] = await Promise.all([
    runBirthdayCampaigns(mongoDb).catch(e => { console.error('[CRM/birthday]', e.message); return 0; }),
    runReengagementCampaigns(mongoDb).catch(e => { console.error('[CRM/reengagement]', e.message); return 0; }),
  ]);
  if (b + r > 0) console.log(`[CRM] Campanhas: ${b} aniversário, ${r} reengajamento`);
  return { birthday: b, reengagement: r };
}

module.exports = { syncCustomers, sendWhatsApp, applyTemplate, parseBirthDay, runBirthdayCampaigns, runReengagementCampaigns, runScheduledCampaigns };
