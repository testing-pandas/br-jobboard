import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import slugify from 'slugify';
import { OpenAI } from 'openai';
import { convert } from 'html-to-text';
import cron from 'node-cron';
import crypto from 'node:crypto';
import sax from 'sax';
import fetch from 'node-fetch';

// ========================================
// ENVIRONMENT VARIABLES
// ========================================
const PORT = Number(process.env.PORT || 3004);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/,'');
const SITE_NAME = process.env.SITE_NAME || 'Vagas de Motorista Brasil';
const FAVICON_URL = process.env.FAVICON_URL || '';
const SITE_LOGO = process.env.SITE_LOGO || '';
const SITE_SAMEAS = process.env.SITE_SAMEAS || ''; // Comma-separated social URLs
const TARGET_LANG = process.env.TARGET_LANG || 'pt';
const FEED_URL = process.env.FEED_URL || '';
const MAX_JOBS = Number(process.env.MAX_JOBS || 1000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 */6 * * *';
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const CLICK_SECRET = process.env.CLICK_SECRET || crypto.randomBytes(16).toString('hex');
const TARGET_PROFESSION = process.env.TARGET_PROFESSION || 'motorista';
const AI_PROCESS_LIMIT = Number(process.env.AI_PROCESS_LIMIT || 0); // 0 = unlimited

// Keywords for profession matching (lowercase)
const PROFESSION_KEYWORDS = (process.env.PROFESSION_KEYWORDS || 'motorista de caminhão, caminhoneiro, condutor de caminhão, motorista profissional, condutor profissional, motorista de longa distância, condutor de longa distância, motorista internacional, condutor internacional, motorista de estrada, condutor rodoviário, motorista de carreta, condutor de carreta, motorista de caminhão articulado, motorista CE, condutor CE, motorista categoria C, condutor categoria C, motorista de caminhão basculante, motorista de caminhão-tanque, motorista de caminhão frigorífico, motorista entregador, motorista de caminhão basculante, motorista de cegonha, motorista de transporte de cargas, condutor de caminhão guindaste, motorista de transporte especial, motorista entregador de cargas pesadas, condutor entregador, motorista de utilitário, motorista de veículo leve, condutor de veículo leve')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ========================================
// DATABASE SETUP
// ========================================
const db = new Database('jobs.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE,
  source TEXT,
  title TEXT,
  company TEXT,
  description_html TEXT,
  description_short TEXT,
  url TEXT,
  published_at INTEGER,
  slug TEXT UNIQUE,
  tags_csv TEXT DEFAULT '',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_slug ON jobs(slug);
CREATE INDEX IF NOT EXISTS idx_jobs_guid ON jobs(guid);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  slug TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

CREATE TABLE IF NOT EXISTS job_tags (
  job_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  UNIQUE(job_id, tag_id) ON CONFLICT IGNORE
);
CREATE INDEX IF NOT EXISTS idx_job_tags_job_id ON job_tags(job_id);
CREATE INDEX IF NOT EXISTS idx_job_tags_tag_id ON job_tags(tag_id);

CREATE TABLE IF NOT EXISTS stats_cache (
  key TEXT PRIMARY KEY,
  value INTEGER,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

// ========================================
// PREPARED STATEMENTS
// ========================================
const stmtInsertJob = db.prepare(`
INSERT OR IGNORE INTO jobs
(guid, source, title, company, description_html, description_short, url, published_at, slug, tags_csv)
VALUES (@guid, @source, @title, @company, @description_html, @description_short, @url, @published_at, @slug, @tags_csv)
`);
const stmtHasGuid = db.prepare(`SELECT id FROM jobs WHERE guid=? LIMIT 1`);
const stmtBySlug = db.prepare(`SELECT * FROM jobs WHERE slug=? LIMIT 1`);
const stmtById = db.prepare(`SELECT * FROM jobs WHERE id=? LIMIT 1`);

// Cursor-based pagination
const stmtPageCursor = db.prepare(`
SELECT id, title, company, description_short, slug, published_at
FROM jobs
WHERE published_at < ? OR (published_at = ? AND id < ?)
ORDER BY published_at DESC, id DESC
LIMIT ?
`);
const stmtPageFirst = db.prepare(`
SELECT id, title, company, description_short, slug, published_at
FROM jobs
ORDER BY published_at DESC, id DESC
LIMIT ?
`);

// Search
const stmtSearch = db.prepare(`
SELECT id, title, company, description_short, slug, published_at
FROM jobs
WHERE title LIKE ? OR company LIKE ?
ORDER BY published_at DESC, id DESC
LIMIT 1000
`);

// Tag queries
const stmtGetTagBySlug = db.prepare(`SELECT * FROM tags WHERE slug=? LIMIT 1`);
const stmtGetTagByName = db.prepare(`SELECT * FROM tags WHERE name=? LIMIT 1`);
const stmtInsertTag = db.prepare(`INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)`);
const stmtInsertJobTag = db.prepare(`INSERT OR IGNORE INTO job_tags (job_id, tag_id) VALUES (?, ?)`);
const stmtCountJobsByTagId = db.prepare(`SELECT COUNT(*) AS c FROM job_tags WHERE tag_id=?`);
const stmtJobsByTagCursor = db.prepare(`
SELECT j.id, j.title, j.company, j.description_short, j.slug, j.published_at
FROM jobs j
JOIN job_tags jt ON jt.job_id = j.id
JOIN tags t ON t.id = jt.tag_id
WHERE t.slug = ?
  AND (j.published_at < ? OR (j.published_at = ? AND j.id < ?))
ORDER BY j.published_at DESC, j.id DESC
LIMIT ?
`);
const stmtJobsByTagFirst = db.prepare(`
SELECT j.id, j.title, j.company, j.description_short, j.slug, j.published_at
FROM jobs j
JOIN job_tags jt ON jt.job_id = j.id
JOIN tags t ON t.id = jt.tag_id
WHERE t.slug = ?
ORDER BY j.published_at DESC, j.id DESC
LIMIT ?
`);

// Popular tags & recent
const stmtPopularTags = db.prepare(`
SELECT t.name, t.slug, COUNT(*) AS cnt
FROM tags t
JOIN job_tags jt ON jt.tag_id = t.id
GROUP BY t.id
HAVING cnt >= ?
ORDER BY cnt DESC, t.name ASC
LIMIT ?
`);
const stmtRecent = db.prepare(`
SELECT title, slug, published_at
FROM jobs
ORDER BY published_at DESC, id DESC
LIMIT ?
`);

// Stats cache
const stmtGetCache = db.prepare(`SELECT value FROM stats_cache WHERE key=? AND updated_at > ?`);
const stmtSetCache = db.prepare(`
INSERT OR REPLACE INTO stats_cache (key, value, updated_at)
VALUES (?, ?, strftime('%s','now'))
`);

function getCachedCount(ttlSeconds = 300) {
  const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
  const cached = stmtGetCache.get('total_jobs', cutoff);
  if (cached) return cached.value;
  const count = db.prepare(`SELECT COUNT(*) as c FROM jobs`).get().c;
  stmtSetCache.run('total_jobs', count);
  return count;
}

const stmtDeleteOld = db.prepare(`
DELETE FROM jobs
WHERE id IN (
  SELECT id FROM jobs
  ORDER BY published_at DESC, id DESC
  LIMIT -1 OFFSET ?
)
`);

// ========================================
// HELPERS
// ========================================
const openai = HAS_OPENAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const mkSlug = (s) => slugify(String(s || 'job'), { lower: true, strict: true }).slice(0, 120);
const unixtime = (d) => Math.floor(new Date(d).getTime() / 1000);

function truncateWords(txt, n = 60) {
  const words = (txt || '').split(/\s+/);
  if (words.length <= n) return txt || '';
  return words.slice(0, n).join(' ') + '…';
}

function uniqNormTags(tags = []) {
  const seen = new Set();
  const out = [];
  for (let t of tags) {
    if (!t) continue;
    t = String(t).trim().toLowerCase();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 8);
}
function tagSlug(t) { return mkSlug(t); }

// Security: Sanitize HTML to prevent XSS (lightweight)
function sanitizeHtml(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(?:iframe|object|embed|link|style|noscript)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi, '')
    .replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, '');
}

// Strip full HTML document tags (DOCTYPE, html, head, body)
function stripDocumentTags(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<title[^>]*>.*?<\/title>/gi, '')
    .trim();
}

// HTML escaping for text content
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Canonical URL helper (handles leading/trailing slashes)
function canonical(path = '') {
  const p = String(path || '');
  if (/^https?:\/\//i.test(p)) return p;
  return `${SITE_URL}${p.startsWith('/') ? '' : '/'}${p}`;
}

// Check if job matches target profession
function matchesProfession(title = '', company = '', description = '') {
  const text = `${title} ${company} ${description}`.toLowerCase();
  return PROFESSION_KEYWORDS.some(keyword => text.includes(keyword));
}

// Extract tags related to profession (BR)

const PROFESSION_TAGS = {
  warehouse: [
    'armazém','trabalhador de armazém','associado de armazém','operador de armazém',
    'trabalhador geral','repositor','separador','embalador','separador de pedidos',
    'carregador','descarregador','trabalhador de doca','operador de empilhadeira',
    'operador de empilhadeira elétrica','manuseador de materiais','assistente de expedição',
    'assistente de recebimento','especialista em controle de inventário',
    'supervisor de armazém','gerente de armazém','associado de logística',
    'associado de distribuição','associado da cadeia de suprimentos',
    'estoquista','almoxarife','auxiliar de armazém','operador de paleteira',
    'operador de empilhadeira retrátil','contador cíclico','inspector de recebimento'
  ],
  'truck driver': [
    'categoria e','categoria a','cnh','longa distância','regional','local',
    'caminhão-tanque','carroceria plana','otr','cargas perigosas (hazmat)'
  ],
  'software engineer': [
    'javascript','python','java','react','node','backend','frontend','full stack','devops'
  ],
  nurse: [
    'enfermeiro(a)','técnico(a) de enfermagem','uti','emergência','pediatria',
    'cirúrgico','cuidados intensivos','oncologia'
  ],
  electrician: [
    'comercial','residencial','industrial','aprendiz','eletricista qualificado','mestre eletricista'
  ],
  mechanic: [
    'automotivo','diesel','equipamentos pesados','marítimo','aeronaves','certificação ase'
  ],
  welder: [
    'mig','tig','eletrodo revestido','flux core','soldagem de tubos','estrutural','aço inoxidável'
  ],
  // дублікатний «warehouse» нижче лишаємо як синоніми:
  'warehouse+': ['empilhadeira','empilhadeira retrátil','separador','embalador','expedição','recebimento','inventário']
};

function extractTags({ title = '', company = '', html = '' }) {
  const text = `${title} ${company} ${convert(html || '', { wordwrap: 120 }).slice(0, 1000)}`.toLowerCase();
  const profKey = TARGET_PROFESSION.toLowerCase();
  const profTags = PROFESSION_TAGS[profKey] || PROFESSION_TAGS[' Warehouse'] || [];
  const found = profTags.filter(tag => text.includes(tag));

  if (/(remote|homeoffice|home office|work from home|telecommute)/i.test(text)) found.push('remote');
  if (/(vollzeit|full time|full-time)/i.test(text)) found.push('full-time');
  if (/(teilzeit|part time|part-time)/i.test(text)) found.push('part-time');
  if (/(festanstellung|unbefristet|permanent)/i.test(text)) found.push('permanent');
  if (/(befristet|temporary|zeitarbeit|contract)/i.test(text)) found.push('contract');

  found.push(TARGET_PROFESSION.toLowerCase());

  return uniqNormTags(found);
}

// ======= UPDATED parseMeta (adds experience fields) =======
function parseMeta(textHTML = '', title = '') {
  const text = (convert(textHTML || '', { wordwrap: 1000 }) + ' ' + (title || '')).toLowerCase();

  let employmentType = 'FULL_TIME';

  if (/(meio[-\s]?período|tempo parcial|part[-\s]?time)/i.test(text)) {
    employmentType = 'PART_TIME';
  } else if (/(temporário|temporaria|temporario|contrato|freelancer|terceirizado|zeitarbeit|contractor)/i.test(text)) {
    employmentType = 'CONTRACTOR';
  } else if (/(estágio|internship|interno|aprendizagem|trainee|ausbildung)/i.test(text)) {
    employmentType = 'INTERN';
  } else if (/(temporário|sazonal|temporada|temporario|seasonal|saisonarbeit)/i.test(text)) {
    employmentType = 'TEMPORARY';
  }
  
  // Trabalho remoto
  const isRemote = /(remoto|home[-\s]?office|trabalho remoto|work from home|teletrabalho|telecommute)/i.test(text);
  
  // Unidade de salário
  let unit = 'HOUR';
  if (/\b(ano|anual|ano inteiro|per year|annually|por ano|jährlich|yearly)\b/i.test(text)) {
    unit = 'YEAR';
  } else if (/\b(mês|mensal|per month|por mês|monat|monthly)\b/i.test(text)) {
    unit = 'MONTH';
  } else if (/\b(semana|semanal|per week|pro woche|weekly)\b/i.test(text)) {
    unit = 'WEEK';
  } else if (/\b(dia|diário|per day|pro tag|daily)\b/i.test(text)) {
    unit = 'DAY';
  } else if (/\b(hora|horário|por hora|hourly|stunde)\b/i.test(text)) {
    unit = 'HOUR';
  }
  


// Розпізнавання валюти: BRL, EUR, USD, GBP, CHF
let currency = null, min = null, max = null;
const cMatch = text.match(/\b(brl|real|reais|eur|euro|usd|dólar|chf|franco|gbp|libra)\b|[R$€$£]/i);

if (cMatch) {
  const c = cMatch[0].toUpperCase().replace(/\s/g, '');

  currency = (c === 'R$' || c === 'BRL' || c === 'REAL' || c === 'REAIS') ? 'BRL'
    : (c === '€' || c === 'EUR' || c === 'EURO') ? 'EUR'
    : (c === '$' || c === 'USD' || c === 'DÓLAR') ? 'USD'
    : (c === '£' || c === 'GBP' || c === 'LIBRA') ? 'GBP'
    : (c === 'CHF' || c === 'FRANCO') ? 'CHF'
    : null;
}

  const range = text.match(/(\d{1,2}[.,]?\d{3,6})\s*[-–—bis]\s*(\d{1,2}[.,]?\d{3,6})/i);
  if (range) {
    min = Number(range[1].replace(/[.,]/g, ''));
    max = Number(range[2].replace(/[.,]/g, ''));
  } else {
    const one = text.match(/(?:ab|from|von)\s*(\d{1,2}[.,]?\d{3,6})|(\d{1,2}[.,]?\d{3,6})\s*(?:\+|bis)/i);
    if (one) {
      const val = one[1] || one[2];
      min = Number(String(val || '').replace(/[.,]/g, ''));
    }
  }

// Experiência
let experienceRequirements = null;
const yearsMatch = text.match(/(\d+)\s*\+?\s*(anos|jahre|years|yrs)\s*(de\s+)?(experiência|erfahrung|experience)/i);
if (yearsMatch) {
  const yrs = yearsMatch[1];
  experienceRequirements = `${yrs} years of relevant experience`;
} else if (/(experiência requerida|experiência necessária|erfahrung erforderlich|experience required)/i.test(text)) {
  experienceRequirements = `Relevant experience required`;
}
const experienceInPlaceOfEducation =
  /(ou experiência equivalente|or equivalent experience|gleichwertige erfahrung|або еквівалентний досвід)/i.test(text)
    ? true
    : false;

  return {
    employmentType,
    isRemote,
    salary: (currency && (min || max)) ? { currency, min, max, unit } : null,
    experienceRequirements,
    experienceInPlaceOfEducation
  };
}

// ======= NEW helpers to guarantee jobLocation =======

// Infer ISO country from SITE_URL host TLD (fallback to 'US' if unknown)
function getCountryFromHost(siteUrl) {
  try {
    const host = new URL(siteUrl).hostname.toLowerCase();
    const tld = host.split('.').pop();
    const map = {
      de: 'DE', at: 'AT', br: 'BR', ch: 'CH', li: 'LI',
      uk: 'GB', gb: 'GB', ie: 'IE',
      us: 'US', ca: 'CA', au: 'AU', nz: 'NZ',
      nl: 'NL', be: 'BE', fr: 'FR', es: 'ES', pt: 'PT', it: 'IT',
      pl: 'PL', cz: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG',
      ua: 'UA', rs: 'RS', hr: 'HR', si: 'SI',
      dk: 'DK', se: 'SE', no: 'NO', fi: 'FI', is: 'IS',
      ee: 'EE', lv: 'LV', lt: 'LT'
    };
    return map[tld] || 'US';
  } catch {
    return 'US';
  }
}

/**
 * Always return a valid JobPosting.jobLocation array.
 * If remote, still include a Place with broad country (allowed by Google alongside jobLocationType).
 * Attempts a light city sniff; otherwise returns country-only.
 */
function inferJobLocations(html = '', title = '', siteUrl = SITE_URL) {
  const country = getCountryFromHost(siteUrl);
  const text = (convert(html || '', { wordwrap: 1000 }) + ' ' + (title || '')).toLowerCase();

  // Minimal city lexicon for DE context (safe). Extend as needed.
  const citiesBR = [
    'são paulo', 'sao paulo', 'sp',
    'rio de janeiro', 'rj',
    'brasilia', 'df',
    'salvador', 'ssa',
    'fortaleza', 'ce',
    'belo horizonte', 'bh', 'mg',
    'manaus', 'am',
    'curitiba', 'pr',
    'recife', 'pe',
    'porto alegre', 'rs',
    'goiânia', 'goiania', 'go',
    'belém', 'belem', 'pa',
    'são luís', 'sao luis', 'ma',
    'maceió', 'maceio', 'al',
    'natal', 'rn',
    'terezina', 'teresina', 'pi',
    'joão pessoa', 'joao pessoa', 'pb',
    'campo grande', 'ms',
    'cuiabá', 'cuiaba', 'mt',
    'florianópolis', 'florianopolis', 'sc',
    'aracaju', 'se',
    'palmas', 'to'
  ];
  
  let city = null;
  for (const c of citiesBR) {
    if (text.includes(c)) { city = c; break; }
  }

  const address = city
    ? { "@type": "PostalAddress", "addressLocality": city[0].toUpperCase() + city.slice(1), "addressCountry": country }
    : { "@type": "PostalAddress", "addressCountry": country };

  return [{
    "@type": "Place",
    "address": address
  }];
}

// Unit labels for UI printing
const UNIT_LABELS = {
  YEAR: 'ano',
  MONTH: 'mês',
  WEEK: 'semana',
  DAY: 'dia',
  HOUR: 'hora'
};


// AI rewriting with proper limit + correct section parsing
async function rewriteJobRich({ title, company, html }, useAI = false) {
  const plain = convert(html || '', {
    wordwrap: 120,
    selectors: [{ selector: 'a', options: { ignoreHref: true } }]
  }).slice(0, 9000);

  const fallback = () => {
    const paragraphs = plain.split(/\n+/).filter(Boolean).slice(0, 6).map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
    const fallbackHTML = `
<section><h2>Sobre a Vaga</h2>${paragraphs || '<p>Detalhes fornecidos pelo empregador.</p>'}</section>

<section><h2>Responsabilidades</h2>
  <ul>
    <li>Executar as atividades principais conforme descrito.</li>
  </ul>
</section>

<section><h2>Requisitos</h2>
  <ul>
    <li>Experiência relevante ou disposição para aprender.</li>
  </ul>
</section>

<section><h2>Benefícios</h2>
  <ul>
    <li>Benefícios conforme descrição da vaga.</li>
  </ul>
</section>

<section><h2>Remuneração</h2>
  <p>A ser discutida.</p>
</section>

<section><h2>Local e Horário</h2>
  <p>Conforme descrição da vaga.</p>
</section>

<section><h2>Como se Candidatar</h2>
  <p>Use o botão “Candidatar-se”.</p>
</section>

`.trim();

    return {
      short: truncateWords(plain, 45),
      html: sanitizeHtml(fallbackHTML),
      tags: extractTags({ title, company, html }),
      usedAI: false
    };
  };

  if (!HAS_OPENAI || !useAI || !openai) return fallback();

  const system = `
Você é editor sênior de RH para vagas de ${TARGET_PROFESSION}. Escreva de forma natural em ${TARGET_LANG}.
CONTRATO DE SAÍDA — retorne EXATAMENTE estes três blocos nesta ordem:
===DESCRIPTION=== [60–100 palavras em texto simples. Sem HTML, aspas ou emojis.]
===HTML=== [Apenas fragmentos HTML limpos; NUNCA inclua <!DOCTYPE>, <html>, <head> ou <body>.]
===TAGS=== [Array JSON válido (3–8 itens), tudo em minúsculas, em ${TARGET_LANG}, relevante para ${TARGET_PROFESSION}.]

SEÇÕES HTML (traduza os títulos para ${TARGET_LANG}; mantenha esta ordem):
1) Sobre a Vaga
2) Responsabilidades
3) Requisitos
4) Benefícios
5) Remuneração
6) Local e Horário
7) Como se Candidatar

REGRAS DE HTML:
- Use marcação semântica, mínima e válida: <section>, <h2>, <p>, <ul>, <li>, <strong>, <em>, <time>, <address>.
- Envolva cada bloco lógico com <section> e os títulos <h2> traduzidos acima (ordem fixa). Não deixe seções vazias.
- Listas devem ser escaneáveis: 5–8 itens por lista, com 4–12 palavras por item.
- Não use estilos inline, scripts, imagens ou tabelas.
- Não inclua links externos, a menos que um link explícito de candidatura esteja presente na mensagem do usuário; caso contrário, omita todos os links.
- Use unidades métricas e formatos locais apropriados.

DIRETRIZES DE CONTEÚDO:
- DESCRIPTION: 40–70 palavras, voz ativa, proposta de valor concreta, sem enrolação.
- Responsabilidades e Requisitos: 30–40 palavras, resultados concretos, ferramentas, exigências claras; evite clichês.
- Benefícios: 35–60 palavras, realistas, com vantagens geralmente aplicáveis.
- Remuneração: 30–60 palavras, indique uma faixa quando disponível; caso contrário, use “A combinar”.
- Local e Horário: 10–30 palavras, reflita informações conhecidas; caso contrário, use texto genérico.
- Como se Candidatar: 10–20 palavras, frase simples e direta; não inclua link a menos que explicitamente fornecido.

VALIDAÇÃO RIGOROSA ANTES DE RETORNAR:
- DESCRIPTION com 35–60 palavras, sem HTML.
- HTML contém exatamente sete blocos <section> com títulos <h2> traduzidos e na ordem exata.
- TAGS deve ser um array JSON válido (3–8 itens), todos em minúsculas e relevantes.
- Não invente informações sobre o empregador ou links.
`;
const user = `Vaga: ${title || 'N/D'}
Empresa: ${company || 'N/D'}
Texto:
${plain}`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const out = resp.choices?.[0]?.message?.content || '';
    const descMatch = out.match(/===DESCRIPTION===\s*([\s\S]*?)\s*===HTML===/i);
    const htmlMatch = out.match(/===HTML===\s*([\s\S]*?)\s*===TAGS===/i);
    const tagsMatch = out.match(/===TAGS===\s*([\s\S]*)$/i);

    let short = (descMatch?.[1] || '').trim();
    if (!short) short = convert(out, { wordwrap: 120 }).slice(0, 300);
    short = convert(short, { wordwrap: 120 }).trim().slice(0, 600);

    let htmlOut = (htmlMatch?.[1] || '').trim();
    if (!htmlOut) {
      htmlOut = `<section><h2>Sobre a Vaga</h2><p>${escapeHtml(short)}</p></section>`;
    }
    htmlOut = stripDocumentTags(htmlOut);
    if (htmlOut.length < 50) {
      htmlOut = `<section><h2>Sobre a Vaga</h2><p>${escapeHtml(short)}</p></section>`;
    }    

    let tagsParsed = null;
    try {
      const m = (tagsMatch?.[1] || '').match(/\[[\s\S]*\]/);
      if (m) tagsParsed = JSON.parse(m[0]);
    } catch { /* noop */ }

    const tags = uniqNormTags(tagsParsed || extractTags({ title, company, html }));

    return { short, html: sanitizeHtml(htmlOut), tags, usedAI: true };
  } catch (e) {
    console.error('OpenAI error:', e.message);
    return fallback();
  }
}

function upsertTagsForJob(jobId, tags = []) {
  const insertTag = db.transaction((names) => {
    for (const name of names) {
      const slug = tagSlug(name);
      stmtInsertTag.run(name, slug);
      const t = stmtGetTagByName.get(name);
      if (t) stmtInsertJobTag.run(jobId, t.id);
    }
  });
  insertTag(tags);
}

// ========================================
// FEED PROCESSING (with AI limit)
// ========================================
let FEED_RUNNING = false;

export async function processFeed() {
  if (FEED_RUNNING) {
    console.log('Feed processing already running, skipping...');
    return;
  }
  if (!FEED_URL) {
    console.log('No FEED_URL configured');
    return;
  }

  FEED_RUNNING = true;
  try {
    console.log(`\nFetching XML feed: ${FEED_URL}`);
    console.log(`Filtering for profession: ${TARGET_PROFESSION}`);
    console.log(`Keywords: ${PROFESSION_KEYWORDS.join(', ')}`);
    console.log(`AI Processing: ${AI_PROCESS_LIMIT === 0 ? 'Unlimited' : `First ${AI_PROCESS_LIMIT} jobs`}`);
    console.log('Starting streaming XML parser...\n');

    const response = await fetch(FEED_URL);
    const stream = response.body;

    let matched = 0;
    let processed = 0;
    let skipped = 0;
    let aiEnhanced = 0;
    let fallbackUsed = 0;

    const batchSize = 100;
    const insertBatch = db.transaction((jobs) => {
      for (const job of jobs) {
        stmtInsertJob.run(job);
        const inserted = stmtHasGuid.get(job.guid);
        if (inserted) {
          upsertTagsForJob(inserted.id, job.tags_csv.split(', ').filter(Boolean));
        }
      }
    });

    let batch = [];
    let currentItem = null;
    let currentTag = '';
    let currentText = '';

    const parser = sax.createStream(true, { trim: true, normalize: true });

    parser.on('opentag', (node) => {
      currentTag = node.name.toLowerCase();
      currentText = '';
      if (currentTag === 'job' || currentTag === 'item') {
        currentItem = { title: '', description: '', company: '', link: '', guid: '', pubDate: new Date().toISOString() };
      }
    });

    parser.on('text', (text) => { currentText += text; });
    parser.on('cdata', (text) => { currentText += text; });

    parser.on('closetag', (tagName) => {
      tagName = tagName.toLowerCase();
      if (!currentItem) return;

      switch (tagName) {
        case 'title': currentItem.title = currentText.trim(); break;
        case 'description': currentItem.description = currentText.trim(); break;
        case 'company': currentItem.company = currentText.trim(); break;
        case 'url':
        case 'link': currentItem.link = currentText.trim(); break;
        case 'guid':
        case 'referencenumber':
          if (!currentItem.guid) currentItem.guid = currentText.trim();
          break;
        case 'pubdate':
        case 'date_updated': currentItem.pubDate = currentText.trim(); break;
      }

      if (tagName === 'job' || tagName === 'item') {
        processed++;
        if (processed % 10000 === 0) {
          console.log(`Processed ${processed.toLocaleString()} items (matched: ${matched.toLocaleString()}, skipped: ${skipped.toLocaleString()})`);
        }

        const guid = currentItem.guid || currentItem.link || `job-${processed}`;
        if (stmtHasGuid.get(guid)) {
          skipped++;
          currentItem = null;
          return;
        }
        if (!matchesProfession(currentItem.title, currentItem.company, currentItem.description)) {
          skipped++;
          currentItem = null;
          return;
        }

        matched++;
        batch.push({
          rawTitle: currentItem.title,
          rawCompany: currentItem.company,
          rawDescription: currentItem.description,
          guid,
          source: new URL(FEED_URL).hostname,
          url: currentItem.link,
          published_at: unixtime(currentItem.pubDate)
        });
        currentItem = null;
      }
    });

    parser.on('error', (err) => {
      console.error('SAX Parser Error:', err.message);
    });

    await new Promise((resolve, reject) => {
      stream.pipe(parser);

      parser.on('end', async () => {
        if (batch.length > 0) {
          console.log(`\nProcessing ${batch.length} matched jobs...`);
          const processedBatch = [];
          for (let i = 0; i < batch.length; i++) {
            const rawJob = batch[i];
            const shouldUseAI = (AI_PROCESS_LIMIT === 0) || (aiEnhanced < AI_PROCESS_LIMIT);
            const { short, html, tags, usedAI } = await rewriteJobRich(
              { title: rawJob.rawTitle, company: rawJob.rawCompany, html: rawJob.rawDescription },
              shouldUseAI
            );

            if (usedAI) {
              aiEnhanced++;
              if (aiEnhanced % 10 === 0) console.log(`AI-enhanced: ${aiEnhanced} jobs...`);
            } else {
              fallbackUsed++;
            }

            const slug = mkSlug(`${rawJob.rawTitle}-${rawJob.rawCompany}`) || mkSlug(rawJob.rawTitle) || mkSlug(rawJob.guid);

            processedBatch.push({
              guid: rawJob.guid,
              source: rawJob.source,
              title: rawJob.rawTitle || 'Untitled',
              company: rawJob.rawCompany || '',
              description_html: html,
              description_short: truncateWords(short, 60),
              url: rawJob.url || '',
              published_at: rawJob.published_at,
              slug,
              tags_csv: tags.join(', ')
            });

            if (processedBatch.length >= batchSize) {
              insertBatch(processedBatch);
              processedBatch.length = 0;
            }
          }
          if (processedBatch.length > 0) {
            insertBatch(processedBatch);
          }
        }
        resolve();
      });

      parser.on('error', reject);
      stream.on('error', reject);
    });

    console.log(`\nFeed processing complete!`);
    console.log(`Total processed: ${processed.toLocaleString()} items`);
    console.log(`Matched profession: ${matched.toLocaleString()} jobs`);
    console.log(`AI-enhanced: ${aiEnhanced.toLocaleString()} jobs`);
    console.log(`Fast fallback: ${fallbackUsed.toLocaleString()} jobs`);
    console.log(`Skipped: ${skipped.toLocaleString()} (duplicates/non-matching)\n`);

    const total = getCachedCount(0);
    if (total > MAX_JOBS) {
      console.log(`Cleaning up: keeping ${MAX_JOBS.toLocaleString()} most recent jobs`);
      stmtDeleteOld.run(MAX_JOBS);
      stmtSetCache.run('total_jobs', MAX_JOBS);
    }
  } catch (error) {
    console.error('Feed processing error:', error.message);
    throw error;
  } finally {
    FEED_RUNNING = false;
  }
}

// ========================================
// CSS STYLES (Modern blue theme) + Cookie banner styles
// ========================================
const baseCss = `
:root {
  --primary: #2563eb;
  --primary-dark: #1e40af;
  --bg: #f8fafc;
  --card: #ffffff;
  --text: #1e293b;
  --text-muted: #64748b;
  --border: #e2e8f0;
  --shadow: 0 1px 3px rgba(0,0,0,0.1);
  --shadow-lg: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; }
.wrap { max-width: 1000px; margin: 0 auto; padding: 20px; }
header.wrap { display: flex; justify-content: space-between; align-items: center; padding-top: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border); background: var(--card); flex-wrap: wrap; gap: 16px; }
header h1 { margin: 0; font-size: 24px; }
header h1 a { color: var(--text); text-decoration: none; font-weight: 700; }
.h1 { margin: 0; font-size: 24px; }
.h1 a { color: var(--text); text-decoration: none; font-weight: 700; }
nav { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
nav a { color: var(--text-muted); text-decoration: none; padding: 8px 12px; border-radius: 6px; transition: all 0.2s; }
nav a:hover { color: var(--primary); background: var(--bg); }
.btn { display: inline-block; padding: 10px 18px; background: var(--text); color: white; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 500; text-decoration: none; transition: all 0.2s; }
.btn:hover { background: var(--text-muted); transform: translateY(-1px); }
.btn-primary { background: var(--primary); color: white; font-weight: 600; }
.btn-primary:hover { background: var(--primary-dark); }
.card { background: var(--card); border-radius: 12px; padding: 24px; margin: 16px 0; box-shadow: var(--shadow); border: 1px solid var(--border); transition: all 0.2s; }
.card:hover { box-shadow: var(--shadow-lg); border-color: var(--primary); }
.list { list-style: none; padding: 0; margin: 0; }
.muted { color: var(--text-muted); }
.small { font-size: 14px; }
.search-form { margin: 24px 0; }
.search-form input[type="search"] { width: 100%; max-width: 500px; padding: 12px 16px; border: 2px solid var(--border); border-radius: 8px; font-size: 16px; transition: all 0.2s; }
.search-form input[type="search"]:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }
.pager { display: flex; gap: 12px; margin: 24px 0; flex-wrap: wrap; }
.pager a, .pager .current { padding: 8px 16px; background: var(--card); border-radius: 8px; color: var(--text); text-decoration: none; box-shadow: var(--shadow); border: 1px solid var(--border); transition: all 0.2s; }
.pager a:hover { background: var(--primary); color: white; border-color: var(--primary); }
.pager .disabled { opacity: 0.5; pointer-events: none; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.tag { background: #eff6ff; color: var(--primary); border-radius: 999px; padding: 6px 14px; font-size: 13px; text-decoration: none; transition: all 0.2s; border: 1px solid #dbeafe; }
.tag:hover { background: var(--primary); color: white; border-color: var(--primary); }
.content h2 { color: var(--text); margin-top: 24px; font-size: 20px; }
.content p, .content ul, .content ol { line-height: 1.7; margin: 12px 0; }
.content ul, .content ol { padding-left: 24px; }
form label { display: block; margin-top: 16px; margin-bottom: 6px; font-weight: 500; color: var(--text); }
form input[type="text"], form input[type="url"], form input[type="number"], form select, form textarea { width: 100%; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; font-size: 15px; font-family: inherit; transition: all 0.2s; }
form input:focus, form select:focus, form textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }
form textarea { min-height: 150px; resize: vertical; }
form button[type="submit"] { margin-top: 20px; }
.form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.help-text { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
footer { margin-top: 60px; padding-top: 24px; border-top: 1px solid var(--border); }
/* Cookie banner */
.cookie-banner { position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 9999; background: var(--card); color: var(--text); border: 1px solid var(--border); box-shadow: var(--shadow-lg); border-radius: 12px; padding: 16px; display: none; }
.cookie-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.cookie-link { color: var(--primary); text-decoration: none; }
.cookie-link:hover { text-decoration: underline; }
@media (max-width: 768px) {
  header.wrap { flex-direction: column; align-items: flex-start; }
  nav { width: 100%; justify-content: flex-start; }
  .form-row { grid-template-columns: 1fr; }
}
`;

// ========================================
// HTML LAYOUT FUNCTION (with cookie banner)
// ========================================
function layout({ title, body, metaExtra = '', breadcrumbs = null }) {
  const faviconHtml = FAVICON_URL ? `<link rel="icon" href="${escapeHtml(FAVICON_URL)}"/>` : '';
  const canonicalUrl = canonical(breadcrumbs ? breadcrumbs[breadcrumbs.length - 1].url : '/');

  // Breadcrumb JSON-LD (if provided)
  let breadcrumbSchema = '';
  if (breadcrumbs && breadcrumbs.length > 1) {
    breadcrumbSchema = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": breadcrumbs.map((crumb, idx) => ({
        "@type": "ListItem",
        "position": idx + 1,
        "name": crumb.name,
        "item": canonical(crumb.url)
      }))
    })}</script>`;
  }

  const cookieBanner = `
<div id="cookie-banner" class="cookie-banner" role="dialog" aria-live="polite" aria-label="Consentimento de cookies">
  <div>
    <strong>Usamos cookies</strong>
    <p class="small muted" style="margin:6px 0 0 0;">
      Utilizamos cookies essenciais para operar o ${escapeHtml(SITE_NAME)} e melhorar sua experiência.
      Veja nossa <a class="cookie-link" href="/cookies">Política de Cookies</a> e <a class="cookie-link" href="/privacy">Política de Privacidade</a>.
    </p>
    <div class="cookie-actions">
      <button id="cookie-accept" class="btn btn-primary">Aceitar todos</button>
      <a class="cookie-link" href="/cookies">Gerenciar preferências</a>
    </div>
  </div>
</div>
<script>
(function(){
  function getCookie(name){
    return document.cookie.split('; ').find(row => row.startsWith(name + '='))?.split('=')[1];
  }
  function showBanner(){
    var el = document.getElementById('cookie-banner');
    if (el) el.style.display = 'block';
  }
  function hideBanner(){
    var el = document.getElementById('cookie-banner');
    if (el) el.style.display = 'none';
  }
  if (!getCookie('cookie_consent')){
    window.addEventListener('load', showBanner);
  }
  var btn = document.getElementById('cookie-accept');
  if (btn){
    btn.addEventListener('click', function(){
      var oneYear = 365*24*60*60;
      document.cookie = 'cookie_consent=1; Max-Age=' + oneYear + '; Path=/; SameSite=Lax';
      hideBanner();
    });
  }
})();
</script>
`;

return `
<!doctype html>
<html lang="${TARGET_LANG}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title ? `${escapeHtml(title)} · ` : ''}${escapeHtml(SITE_NAME)}</title>
<meta name="description" content="Encontre vagas e oportunidades de ${escapeHtml(TARGET_PROFESSION)} no ${escapeHtml(SITE_NAME)}"/>
<link rel="canonical" href="${canonicalUrl}"/>
${faviconHtml}
<link rel="alternate" type="application/rss+xml" title="Feed RSS" href="${canonical('/feed.xml')}"/>
<!-- Open Graph -->
<meta property="og:title" content="${escapeHtml(title || SITE_NAME)}"/>
<meta property="og:description" content="Encontre vagas e oportunidades de ${escapeHtml(TARGET_PROFESSION)}"/>
<meta property="og:url" content="${canonicalUrl}"/>
<meta property="og:type" content="website"/>
${SITE_LOGO ? `<meta property="og:image" content="${escapeHtml(SITE_LOGO)}"/>` : ''}
<!-- Twitter Card -->
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${escapeHtml(title || SITE_NAME)}"/>
<meta name="twitter:description" content="Encontre vagas de ${escapeHtml(TARGET_PROFESSION)}"/>
<style>${baseCss}</style>
${breadcrumbSchema}
${metaExtra}
</head>
<body>
<header class="wrap">
  <span class="h1"><a href="/">${escapeHtml(SITE_NAME)}</a></span>
  <nav>
    <a href="/post-job" class="btn btn-primary">Anunciar Vaga</a>
    <a href="/tags">Tags</a>
    <a href="/feed.xml">RSS</a>
    <a href="/rules">Regras</a>
    <a href="/privacy">Privacidade</a>
    <a href="/terms">Termos</a>
  </nav>
</header>
<main class="wrap">
${body}
</main>
<footer class="wrap">
  <p class="muted small">© ${new Date().getFullYear()} ${escapeHtml(SITE_NAME)} · vagas para ${escapeHtml(TARGET_PROFESSION)} · <a href="/privacy">Privacidade</a> · <a href="/terms">Termos</a> · <a href="/cookies">Cookies</a></p>
</footer>
${cookieBanner}
</body>
</html>
`;
}
// ========================================
// HTTP SERVER
// ========================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), jobs: getCachedCount(), feedRunning: FEED_RUNNING, aiEnabled: HAS_OPENAI });
});

// HOME PAGE with search form
app.get('/', (req, res) => {
  const pageSize = 50;
  const cursor = req.query.cursor || '';
  let rows;
  if (!cursor) {
    rows = stmtPageFirst.all(pageSize);
  } else {
    const [pub, id] = cursor.split('-').map(Number);
    if (!pub || !id) return res.status(400).send('Invalid cursor');
    rows = stmtPageCursor.all(pub, pub, id, pageSize);
  }
  const total = getCachedCount();
  const hasMore = rows.length === pageSize;
  const nextCursor = hasMore ? `${rows[rows.length - 1].published_at}-${rows[rows.length - 1].id}` : null;

  const items = rows.map(r => `
<li class="card">
  <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
  ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
  <p>${escapeHtml(r.description_short)}</p>
  <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString('en-US')}</div>
</li>`).join('');

const popular = stmtPopularTags.all(5, 50);
const tagsBlock = popular.length ? `
<section>
  <h3>Tags populares</h3>
  <div class="tags">
    ${popular.map(t => `<a class="tag" href="/tag/${t.slug}">${escapeHtml(t.name)} (${t.cnt})</a>`).join('')}
  </div>
</section>` : '';

const pagerLinks = [];
if (nextCursor) {
  res.setHeader('Link', `<${canonical('/?cursor=' + nextCursor)}>; rel="next"`);
  pagerLinks.push(`<a href="/?cursor=${nextCursor}" rel="next">Próxima →</a>`);
}
if (cursor) {
  pagerLinks.unshift(`<a href="/" rel="prev">← Primeira</a>`);
}
const pager = pagerLinks.length ? `<div class="pager">${pagerLinks.join('')}</div>` : '';


  // Organization JSON-LD (homepage)
  const orgSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE_NAME,
    "url": SITE_URL,
    ...(SITE_LOGO ? { "logo": SITE_LOGO } : {}),
    ...(SITE_SAMEAS ? { "sameAs": SITE_SAMEAS.split(',').map(s => s.trim()).filter(Boolean) } : {})
  })}</script>`;

  // WebSite JSON-LD with SearchAction
  const websiteSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": SITE_NAME,
    "url": SITE_URL,
    "potentialAction": {
      "@type": "SearchAction",
      "target": { "@type": "EntryPoint", "urlTemplate": `${SITE_URL}/search?q={search_term_string}` },
      "query-input": "required name=search_term_string"
    }
  })}</script>`;

  res.send(layout({
    title: 'Vagas Recentes',
    body: `  
<section class="card search-form">
  <form method="GET" action="/search">
    <label for="q">Buscar vagas</label>
    <input type="search" id="q" name="q" placeholder="Buscar por cargo ou empresa..." required/>
    <button type="submit" class="btn" style="margin-top:12px">Buscar</button>
  </form>
</section>

<p class="muted">Exibindo vagas para ${escapeHtml(TARGET_PROFESSION)} · ${total.toLocaleString('pt-BR')} vagas no total</p>

${tagsBlock}

<ul class="list">${items || '<li class="card">Nenhuma vaga encontrada. Acesse /fetch para importar.</li>'}</ul>

${pager}

`,
    metaExtra: orgSchema + websiteSchema
  }));
});

// SEARCH PAGE — set NOINDEX
app.get('/search', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const q = String(req.query.q || '').trim();
  if (!q) return res.redirect('/');
  const searchPattern = `%${q}%`;
  const rows = stmtSearch.all(searchPattern, searchPattern);

  const items = rows.map(r => `
<li class="card">
  <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
  ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
  <p>${escapeHtml(r.description_short)}</p>
  <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString('en-US')}</div>
</li>`).join('');

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Search', url: `/search?q=${encodeURIComponent(q)}` }
  ];

  res.send(layout({
    title: `Search: ${q}`,
    body: `
<nav class="muted small"><a href="/">Início</a> › Buscar</nav>
<h1>Busca: "${escapeHtml(q)}"</h1>
<p class="muted">${rows.length} resultados</p>
<ul class="list">${items || '<li class="card">Nenhum resultado encontrado.</li>'}</ul>
<p><a href="/">← Voltar para todas as vagas</a></p>
`,
    breadcrumbs,
    metaExtra: `<meta name="robots" content="noindex, nofollow"/>`
  }));
});

// POST A JOB (GET - form)
app.get('/post-job', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Post a Job', url: '/post-job' }
  ];
  res.send(layout({
    title: 'Post a Job',
    body: `
<nav class="muted small"><a href="/">Início</a> › Anunciar Vaga</nav>
<article class="card">
  <h1>Anunciar Vaga</h1>
  <p>Cadastre sua vaga de ${escapeHtml(TARGET_PROFESSION)}. Todos os campos marcados com * são obrigatórios.</p>
  <form method="POST" action="/post-job">
    <label for="title">Título da Vaga *</label>
    <input type="text" id="title" name="title" required placeholder="ex: Motorista Categoria D"/>

    <label for="company">Nome da Empresa *</label>
    <input type="text" id="company" name="company" required placeholder="ex: Logística ABC"/>

    <label for="url">URL para Candidatura *</label>
    <input type="url" id="url" name="url" required placeholder="https://..."/>
    <div class="help-text">Onde os candidatos devem se candidatar</div>

    <label for="description">Descrição da Vaga (opcional)</label>
    <textarea id="description" name="description" placeholder="Se deixado em branco, o sistema irá gerar uma descrição estruturada automaticamente..."></textarea>
    <div class="help-text">Deixe em branco para gerar conteúdo com IA ou insira seu próprio texto/HTML</div>

    <label for="tags">Tags (opcional)</label>
    <input type="text" id="tags" name="tags" placeholder="ex: remoto, tempo integral, cnh d"/>
    <div class="help-text">Tags separadas por vírgulas</div>

    <div class="form-row">
      <div>
        <label for="employmentType">Tipo de Contrato</label>
        <select id="employmentType" name="employmentType">
          <option value="FULL_TIME">Tempo Integral</option>
          <option value="PART_TIME">Meio Período</option>
          <option value="CONTRACTOR">Pessoa Jurídica</option>
          <option value="TEMPORARY">Temporário</option>
          <option value="INTERN">Estágio</option>
        </select>
      </div>
      <div>
        <label for="isRemote">Trabalho Remoto</label>
        <select id="isRemote" name="isRemote">
          <option value="no">Não</option>
          <option value="yes">Sim</option>
        </select>
      </div>
    </div>

    <h3 style="margin-top:24px">Informações Salariais (opcional)</h3>
    <div class="form-row">
      <div>
        <label for="currency">Moeda</label>
        <select id="currency" name="currency">
          <option value="">Nenhuma</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
          <option value="CHF">CHF</option>
        </select>
      </div>
      <div>
        <label for="salaryMin">Mínimo</label>
        <input type="number" id="salaryMin" name="salaryMin" placeholder="ex: 2500"/>
      </div>
      <div>
        <label for="salaryMax">Máximo</label>
        <input type="number" id="salaryMax" name="salaryMax" placeholder="ex: 3500"/>
      </div>
      <div>
        <label for="salaryUnit">Por</label>
        <select id="salaryUnit" name="salaryUnit">
          <option value="YEAR">Ano</option>
          <option value="MONTH">Mês</option>
          <option value="WEEK">Semana</option>
          <option value="DAY">Dia</option>
          <option value="HOUR">Hora</option>
        </select>
      </div>
    </div>

    <button type="submit" class="btn btn-primary">Enviar Vaga</button>
  </form>
</article>
`,
    breadcrumbs
  }));
});

// POST A JOB (POST - submission)
app.post('/post-job', async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  try {
    const {
      title, company, url,
      description = '', tags = '',
      employmentType = 'FULL_TIME',
      isRemote = 'no',
      currency = '',
      salaryMin = '',
      salaryMax = '',
      salaryUnit = 'YEAR'
    } = req.body;

    if (!title || !company || !url) {
      return res.status(400).send('Campos obrigatórios ausentes');
    }

    // Унікальні ідентифікатори
    const guid = `manual-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const published_at = Math.floor(Date.now() / 1000);

    // Теги користувача
    const userTags = String(tags || '')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);

    // Одержання фінального HTML/short/tags (AI або фолбек)
    let finalHtml, finalShort, finalTags;

    if (!String(description || '').trim()) {
      console.log('Generating AI content for manual post:', title);
      const result = await rewriteJobRich(
        { title, company, html: `<p>Position at ${escapeHtml(company)}</p>` },
        true
      );
      finalHtml = result.html;
      finalShort = result.short;
      finalTags = [...new Set([...result.tags, ...userTags])];
    } else {
      finalHtml = sanitizeHtml(stripDocumentTags(description));
      finalShort = truncateWords(convert(description, { wordwrap: 120 }), 45);
      finalTags = [...new Set([...extractTags({ title, company, html: description }), ...userTags])];
    }

    // Додаткова зарплатна інформація (якщо заповнено)
    let salaryInfo = '';
    if (currency && (salaryMin || salaryMax)) {
      const unitLabel = UNIT_LABELS[String(salaryUnit).toUpperCase()] || 'period';
      salaryInfo =
        `\n<p><strong>Salary:</strong> ${escapeHtml(currency)} ` +
        `${salaryMin ? escapeHtml(String(salaryMin)) : ''}` +
        `${salaryMin && salaryMax ? '-' : ''}` +
        `${salaryMax ? escapeHtml(String(salaryMax)) : ''} per ${unitLabel}</p>`;
    }

    const enrichedHtml = finalHtml + salaryInfo;
    const slug = mkSlug(`${title}-${company}-${Date.now()}`) || mkSlug(guid);

    // Вставка у БД
    stmtInsertJob.run({
      guid,
      source: 'manual',
      title,
      company,
      description_html: enrichedHtml,
      description_short: finalShort,
      url,
      published_at,
      slug,
      tags_csv: uniqNormTags(finalTags).join(', ')
    });

    // Прив’язуємо теги
    const inserted = stmtHasGuid.get(guid);
    if (inserted) {
      upsertTagsForJob(inserted.id, finalTags);
    }
    stmtSetCache.run('total_jobs', getCachedCount(0));

    console.log(`Manual job posted: ${title} at ${company}`);
    return res.redirect(`/job/${slug}`);
  } catch (error) {
    console.error('Error posting job:', error);
    return res.status(500).send('Error posting job. Please try again.');
  }
});

// PÁGINA DE REGRAS (com FAQ schema)
app.get('/rules', (req, res) => {
  const breadcrumbs = [
    { name: 'Início', url: '/' },
    { name: 'Regras', url: '/rules' }
  ];
  const faqData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Como faço para anunciar uma vaga?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": `Clique no botão “Anunciar Vaga” no topo da página e preencha o formulário. Todas as vagas para ${TARGET_PROFESSION} são bem-vindas.`
        }
      },
      {
        "@type": "Question",
        "name": "É gratuito anunciar vagas?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Sim, anunciar vagas é totalmente gratuito na nossa plataforma."
        }
      },
      {
        "@type": "Question",
        "name": "Por quanto tempo uma vaga permanece publicada?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "As vagas ficam ativas por 30 dias e são incluídas no nosso sitemap e feed RSS."
        }
      }
    ]
  };

  const faqSchema = `<script type="application/ld+json">${JSON.stringify(faqData)}</script>`;
  const orgSchema = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE_NAME,
    "url": SITE_URL,
    ...(SITE_LOGO ? { "logo": SITE_LOGO } : {}),
    ...(SITE_SAMEAS ? {
      "sameAs": SITE_SAMEAS.split(',').map(s => s.trim()).filter(Boolean)
    } : {})
  })}</script>`;

  res.send(layout({
    title: 'Regras e FAQ',
    body: `
<nav class="muted small"><a href="/">Início</a> › Regras</nav>
<article class="card">
  <h1>Regras e Perguntas Frequentes</h1>

  <h2>Diretrizes para Publicação</h2>
  <ul>
    <li>Somente vagas para ${escapeHtml(TARGET_PROFESSION)} devem ser anunciadas</li>
    <li>Todos os anúncios devem representar oportunidades reais</li>
    <li>Informe corretamente os dados da empresa e a URL de candidatura</li>
    <li>Não é permitido conteúdo ou exigências discriminatórias</li>
  </ul>

  <h2>Perguntas Frequentes</h2>

  <h3>Como faço para anunciar uma vaga?</h3>
  <p>Clique no botão “Anunciar Vaga” no topo da página e preencha o formulário. Todas as vagas para ${escapeHtml(TARGET_PROFESSION)} são bem-vindas.</p>

  <h3>É gratuito anunciar vagas?</h3>
  <p>Sim, anunciar vagas é totalmente gratuito na nossa plataforma.</p>

  <h3>Por quanto tempo uma vaga permanece publicada?</h3>
  <p>As vagas ficam ativas por 30 dias e são incluídas no nosso sitemap e feed RSS.</p>

  <h3>Posso editar ou remover um anúncio?</h3>
  <p>Entre em contato conosco caso precise modificar ou remover um anúncio.</p>

  <h3>Como as vagas são processadas?</h3>
  <p>Utilizamos IA para estruturar e melhorar a legibilidade das descrições. Caso forneça sua própria descrição, usaremos exatamente como enviada.</p>
</article>
`,
    breadcrumbs,
    metaExtra: faqSchema + orgSchema
  }));
});

// TAG PAGE with cursor pagination
app.get('/tag/:slug', (req, res) => {
  const slug = req.params.slug;
  const tag = stmtGetTagBySlug.get(slug);
  if (!tag) return res.status(404).send('Not found');

  const pageSize = 50;
  const cursor = req.query.cursor || '';
  let rows;
  if (!cursor) {
    rows = stmtJobsByTagFirst.all(slug, pageSize);
  } else {
    const [pub, id] = cursor.split('-').map(Number);
    if (!pub || !id) return res.status(400).send('Invalid cursor');
    rows = stmtJobsByTagCursor.all(slug, pub, pub, id, pageSize);
  }
  const cnt = stmtCountJobsByTagId.get(tag.id).c;
  const hasMore = rows.length === pageSize;
  const nextCursor = hasMore ? `${rows[rows.length - 1].published_at}-${rows[rows.length - 1].id}` : null;

  const items = rows.map(r => `
<li class="card">
  <h2><a href="/job/${r.slug}">${escapeHtml(r.title)}</a></h2>
  ${r.company ? `<div class="muted">${escapeHtml(r.company)}</div>` : ''}
  <p>${escapeHtml(r.description_short)}</p>
  <div class="muted small">${new Date(r.published_at * 1000).toLocaleDateString('en-US')}</div>
</li>`).join('');

  const pagerLinks = [];
  if (nextCursor) {
    res.setHeader('Link', `<${canonical(`/tag/${slug}?cursor=${nextCursor}`)}>; rel="next"`);
    pagerLinks.push(`<a href="/tag/${slug}?cursor=${nextCursor}" rel="next">Next →</a>`);
  }
  if (cursor) {
    pagerLinks.unshift(`<a href="/tag/${slug}" rel="prev">← First</a>`);
  }
  const pager = pagerLinks.length ? `<div class="pager">${pagerLinks.join('')}</div>` : '';

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: 'Tags', url: '/tags' },
    { name: tag.name, url: `/tag/${slug}` }
  ];

  res.send(layout({
    title: `Tag: ${tag.name}`,
    body: `
<nav class="muted small"><a href="/">Home</a> › <a href="/tags">Tags</a> › ${escapeHtml(tag.name)}</nav>
<h1>Tag: ${escapeHtml(tag.name)}</h1>
<p class="muted">${cnt} jobs</p>
<ul class="list">${items || '<li class="card">No jobs yet.</li>'}</ul>
${pager}
`,
    breadcrumbs
  }));
});

// ALL TAGS
app.get('/tags', (req, res) => {
  const popular = stmtPopularTags.all(1, 500);
  const breadcrumbs = [
    { name: 'Início', url: '/' },
    { name: 'Tags', url: '/tags' }
  ];

  const body = popular.length ? `
<nav class="muted small"><a href="/">Início</a> › Tags</nav>
<h1>Todos os tags</h1>
<div class="tags">
  ${popular.map(t => `<a class="tag" href="/tag/${t.slug}">${escapeHtml(t.name)} (${t.cnt})</a>`).join('')}
</div>
` : `
<nav class="muted small"><a href="/">Início</a> › Tags</nav>
<h1>Tags</h1>
<p class="muted">Nenhuma tag ainda.</p>
`;

  res.send(layout({ title: 'Tags', body, breadcrumbs }));
});

// ======= JOB PAGE (JSON-LD fixed) =======
app.get('/job/:slug', (req, res) => {
  const job = stmtBySlug.get(req.params.slug);
  if (!job) return res.status(404).send('Not found');

  const token = crypto.createHmac('sha256', CLICK_SECRET).update(String(job.id)).digest('hex').slice(0, 16);
  const tags = (job.tags_csv || '').split(',').map(s => s.trim()).filter(Boolean);
  const tagsHtml = tags.length ? `<div class="tags">
    ${tags.map(name => `<a class="tag" href="/tag/${tagSlug(name)}">${escapeHtml(name)}</a>`).join('')}
  </div>` : '';

  const meta = parseMeta(job.description_html || '', job.title || '');
  const datePostedISO = new Date(job.published_at * 1000).toISOString();
  const validThrough = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  // REQUIRED: jobLocation (always present)
  const jobLocations = inferJobLocations(job.description_html || '', job.title || '', SITE_URL);

  // RECOMMENDED fields
  const identifier = {
    "@type": "PropertyValue",
    "name": SITE_NAME,
    "value": String(job.guid || job.id)
  };
  const directApply = false; // this site redirects to source

  const jobPostingJson = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": job.title,
    "description": job.description_html,
    "datePosted": datePostedISO,
    "validThrough": validThrough,
    "employmentType": meta.employmentType,
    "hiringOrganization": {
      "@type": "Organization",
      "name": job.company || "Unknown"
    },
    // REQUIRED:
    "jobLocation": jobLocations,
    // Recommended/optional:
    ...(meta.isRemote ? { "jobLocationType": "TELECOMMUTE" } : {}),
    "identifier": identifier,
    "directApply": directApply,
    ...(meta.experienceRequirements ? { "experienceRequirements": meta.experienceRequirements } : {}),
    "experienceInPlaceOfEducation": Boolean(meta.experienceInPlaceOfEducation),
    ...(meta.salary ? {
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": meta.salary.currency,
        "value": {
          "@type": "QuantitativeValue",
          ...(meta.salary.min ? { "minValue": meta.salary.min } : {}),
          ...(meta.salary.max ? { "maxValue": meta.salary.max } : {}),
          ...(meta.salary.unit ? { "unitText": meta.salary.unit } : {})
        }
      }
    } : {})
  };

  const breadcrumbs = [
    { name: 'Início', url: '/' },
    { name: job.title, url: `/job/${job.slug}` }
  ];

  const metaExtra = `
<script type="application/ld+json">${JSON.stringify(jobPostingJson)}</script>
<meta name="robots" content="index, follow"/>
`;

const body = `
<nav class="muted small"><a href="/">Início</a> › ${escapeHtml(job.title)}</nav>
<article class="card">
  <h1>${escapeHtml(job.title)}</h1>
  ${job.company ? `<div class="muted">${escapeHtml(job.company)}</div>` : ''}
  <div class="muted small">${new Date(job.published_at * 1000).toLocaleDateString('pt-BR')}</div>
  ${tagsHtml}
  <div class="content">${job.description_html || ''}</div>
  <form method="POST" action="/go" style="margin-top:24px">
    <input type="hidden" name="id" value="${job.id}"/>
    <input type="hidden" name="t" value="${token}"/>
    <button class="btn btn-primary" type="submit">Candidatar-se agora</button>
  </form>
</article>
`;

  res.send(layout({ title: job.title, body, metaExtra, breadcrumbs }));
});

// /go - redirect to source (with security token)
app.post('/go', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const id = Number(req.body?.id || 0);
  const t = String(req.body?.t || '');
  if (!id || !t) return res.status(400).send('Bad request');
  const expect = crypto.createHmac('sha256', CLICK_SECRET).update(String(id)).digest('hex').slice(0, 16);
  if (t !== expect) return res.status(403).send('Forbidden');
  const job = stmtById.get(id);
  if (!job || !job.url) return res.status(404).send('Not found');
  return res.redirect(302, job.url);
});
app.get('/go', (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(405).send('Method Not Allowed');
});

// robots.txt
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *
Disallow: /go
Disallow: /post-job
Disallow: /fetch
Sitemap: ${SITE_URL}/sitemap.xml
`);
});

// sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const recent = stmtRecent.all(10000);
  const urls = recent.map(r => `
  <url>
    <loc>${canonical(`/job/${r.slug}`)}</loc>
    <lastmod>${new Date(r.published_at * 1000).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join('');
  res.set('Content-Type', 'application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/tags</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  ${urls}
</urlset>`);
});

// RSS feed
app.get('/feed.xml', (req, res) => {
  const recent = stmtRecent.all(100);
  const items = recent.map(r => `
  <item>
    <title><![CDATA[${r.title}]]></title>
    <link>${canonical(`/job/${r.slug}`)}</link>
    <guid>${canonical(`/job/${r.slug}`)}</guid>
    <pubDate>${new Date(r.published_at * 1000).toUTCString()}</pubDate>
  </item>`).join('');
  res.set('Content-Type', 'application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(SITE_NAME)}</title>
    <link>${SITE_URL}</link>
    <description>Latest ${escapeHtml(TARGET_PROFESSION.toLowerCase())} job opportunities</description>
    <language>${TARGET_LANG}</language>
    <atom:link href="${canonical('/feed.xml')}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`);
});

// ========================================
// LEGAL PAGES (EN)
// ========================================
const LAST_UPDATED = new Date().toISOString().slice(0,10); // YYYY-MM-DD

app.get('/privacy', (req, res) => {
  const breadcrumbs = [
    { name: 'Início', url: '/' },
    { name: 'Política de Privacidade', url: '/privacy' }
  ];
  res.send(layout({
    title: 'Política de Privacidade',
    body: `
<nav class="muted small"><a href="/">Início</a> › Privacidade</nav>
<article class="card content">
  <h1>Política de Privacidade</h1>
  <p class="small muted">Última atualização: ${LAST_UPDATED}</p>
  <p>Respeitamos sua privacidade. Este site armazena apenas os dados mínimos necessários para fornecer sua funcionalidade principal.</p>
  <h2>Dados que processamos</h2>
  <ul>
    <li>Registros do servidor (endereço IP, user agent) para segurança e confiabilidade</li>
    <li>Conteúdo das vagas de emprego que você envia pelo formulário</li>
    <li>Cookies essenciais para lembrar suas preferências de consentimento</li>
  </ul>
  <h2>Finalidade e base legal</h2>
  <p>Processamos dados para operar o site, evitar abusos e fornecer vagas de emprego. A base legal é interesse legítimo e, quando aplicável, seu consentimento.</p>
  <h2>Retenção</h2>
  <p>Os registros são mantidos por um período limitado. As vagas podem ser mantidas enquanto forem relevantes. Cookies de consentimento são armazenados por até um ano.</p>
  <h2>Seus direitos</h2>
  <p>Você pode solicitar acesso ou exclusão dos seus dados pessoais contidos nas vagas que você enviou.</p>
  <h2>Contato</h2>
  <p>Para solicitações de privacidade, entre em contato pelos dados fornecidos no site.</p>
</article>
`,
    breadcrumbs
  }));
});


app.get('/terms', (req, res) => {
  const breadcrumbs = [
    { name: 'Início', url: '/' },
    { name: 'Termos de Uso', url: '/terms' }
  ];
  res.send(layout({
    title: 'Termos de Uso',
    body: `
<nav class="muted small"><a href="/">Início</a> › Termos</nav>
<article class="card content">
  <h1>Termos de Uso</h1>
  <p class="small muted">Última atualização: ${LAST_UPDATED}</p>
  <h2>Aceitação</h2>
  <p>Ao usar o site ${escapeHtml(SITE_NAME)}, você concorda com estes Termos. Se não concordar, não utilize o site.</p>
  <h2>Uso do serviço</h2>
  <ul>
    <li>Publique apenas oportunidades legítimas de trabalho como ${escapeHtml(TARGET_PROFESSION)}</li>
    <li>Não publique conteúdo ilegal ou discriminatório</li>
    <li>Não tente interromper ou abusar do serviço</li>
  </ul>
  <h2>Conteúdo</h2>
  <p>Você é responsável pelo conteúdo que envia. Podemos remover conteúdo que viole estes Termos.</p>
  <h2>Isenção de responsabilidade</h2>
  <p>O site é fornecido "no estado em que se encontra", sem garantias de qualquer tipo.</p>
  <h2>Limitação de responsabilidade</h2>
  <p>Na medida máxima permitida por lei, não somos responsáveis por danos indiretos ou consequenciais.</p>
  <h2>Alterações</h2>
  <p>Podemos atualizar estes Termos periodicamente, publicando uma nova versão nesta página.</p>
</article>
`,
    breadcrumbs
  }));
});


app.get('/cookies', (req, res) => {
  const breadcrumbs = [
    { name: 'Início', url: '/' },
    { name: 'Política de Cookies', url: '/cookies' }
  ];
  res.send(layout({
    title: 'Política de Cookies',
    body: `
<nav class="muted small"><a href="/">Início</a> › Cookies</nav>
<article class="card content">
  <h1>Política de Cookies</h1>
  <p class="small muted">Última atualização: ${LAST_UPDATED}</p>
  <h2>O que são cookies?</h2>
  <p>Cookies são pequenos arquivos de texto armazenados no seu dispositivo que ajudam os sites a funcionar corretamente.</p>
  <h2>Cookies que utilizamos</h2>
  <ul>
    <li><strong>cookie_consent</strong> — lembra a sua escolha de consentimento (expira em 12 meses).</li>
  </ul>
  <h2>Gerenciamento de cookies</h2>
  <p>Você pode excluir cookies nas configurações do seu navegador. Para alterar seu consentimento aqui, limpe os cookies ou clique no botão abaixo.</p>
  <button class="btn" onclick="document.cookie='cookie_consent=; Max-Age=0; Path=/; SameSite=Lax'; alert('Consentimento apagado. Recarregue a página para ver o banner.');">Apagar consentimento</button>
</article>
`,
    breadcrumbs
  }));
});


// Manual feed fetch (for testing/admin)
app.get('/fetch', async (_req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.write('Processing feed...\n\n');
  try {
    await processFeed();
    res.end('Done! Check console for details.\n');
  } catch (e) {
    res.end(`Error: ${e.message}\n`);
  }
});

// ========================================
// STARTUP
// ========================================
if (FEED_URL) {
  processFeed().catch(console.error);
}
if (FEED_URL && CRON_SCHEDULE) {
  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`\nCRON: Starting scheduled feed processing...`);
    processFeed().catch(console.error);
  });
}

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log(`${SITE_NAME}`);
  console.log('='.repeat(60));
  console.log(`Server:       ${SITE_URL}`);
  console.log(`Profession:   ${TARGET_PROFESSION}`);
  console.log(`Keywords:     ${PROFESSION_KEYWORDS.join(', ')}`);
  console.log(`AI Enabled:   ${HAS_OPENAI ? 'Yes' : 'No'}`);
  console.log(`AI Limit:     ${AI_PROCESS_LIMIT === 0 ? 'Unlimited' : `${AI_PROCESS_LIMIT} jobs per feed`}`);
  console.log(`Feed URL:     ${FEED_URL || 'Not configured'}`);
  console.log(`Cron:         ${CRON_SCHEDULE}`);
  console.log(`Favicon:      ${FAVICON_URL || 'None'}`);
  console.log(`Total Jobs:   ${getCachedCount().toLocaleString('en-US')}`);
  console.log('='.repeat(60) + '\n');
});
