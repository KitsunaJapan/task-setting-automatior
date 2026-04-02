require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch     = require('node-fetch');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Basic認証 ──
function basicAuth(req, res, next) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) return next();
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="StratTask"');
    return res.status(401).send('認証が必要です');
  }
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  if (u !== user || p !== pass) {
    res.set('WWW-Authenticate', 'Basic realm="StratTask"');
    return res.status(401).send('IDまたはパスワードが違います');
  }
  next();
}

// ── Sheets API（フロントから受け取ったトークンで叩く） ──
// 既存の名刺アプリと同じ方式：トークンはブラウザが持ち、サーバーはプロキシするだけ
async function sheetsRequest(method, path_, token, body) {
  const sid = process.env.SPREADSHEET_ID || '10gH3TlsQOtgPnDW1AhHErpxNsBXv5kgudGJuHms5jyE';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}${path_}`;
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Sheets error ' + res.status); }
  return res.json();
}

// ── セキュリティ ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://sheets.googleapis.com", "https://oauth2.googleapis.com", "https://accounts.google.com"],
      frameSrc:   ["https://accounts.google.com"],
      imgSrc:     ["'self'", "data:"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public')));

const aiLimiter     = rateLimit({ windowMs: 60000, max: 10, message: { error: 'リクエスト頻度が高すぎます' } });
const sheetsLimiter = rateLimit({ windowMs: 60000, max: 60, message: { error: 'リクエスト頻度が高すぎます' } });

// ── 設定情報 ──
app.get('/api/config', (req, res) => {
  res.json({
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    // クライアントIDはOAuth用に公開（secretは非公開）
    googleClientId:  process.env.GOOGLE_CLIENT_ID || null,
    spreadsheetId:   process.env.SPREADSHEET_ID || '10gH3TlsQOtgPnDW1AhHErpxNsBXv5kgudGJuHms5jyE'
  });
});

// ── AI タスク生成 ──
app.post('/api/generate-tasks', aiLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY が未設定です' });

  const { goal } = req.body;
  if (!goal?.content) return res.status(400).json({ error: '目標内容が必要です' });

  const today = new Date();
  const mon   = new Date(today);
  mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    return d.toISOString().split('T')[0];
  });
  const pLabel = { asap:'ASAP', high:'高', mid:'中', low:'低' };

  const prompt = `あなたはタスク管理の専門家です。以下の中長期目標から今週の具体的な業務タスクを作成してください。

目標: ${goal.content}
達成期間: ${goal.period || '未設定'}
担当者: ${goal.owner || '未設定'}
優先度: ${pLabel[goal.priority] || goal.priority}
備考: ${goal.note || 'なし'}
今週の日付: ${days.join(', ')}

以下のJSON配列のみを返してください（説明文・マークダウン不要）:
[{"date":"YYYY-MM-DD","time":"09-12","name":"タスク名30字以内","detail":"詳細80字以内","priority":"asap|high|mid|low"}]

今週全体で6〜10件、日付を分散させて作成してください。`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) { const e = await response.json(); throw new Error(e.error?.message); }
    const data  = await response.json();
    const text  = data.content.map(c => c.text || '').join('');
    const tasks = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json({ tasks });
  } catch(e) {
    console.error('AI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Sheets プロキシ：フロントからトークンを受け取ってSheetsを叩く ──
// 既存の名刺アプリと同じパターン

app.post('/api/sheets/get', sheetsLimiter, async (req, res) => {
  const { token, range } = req.body;
  if (!token) return res.status(400).json({ error: 'tokenが必要です' });
  try {
    const data = await sheetsRequest('GET', `/values/${encodeURIComponent(range)}`, token);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sheets/batch-update', sheetsLimiter, async (req, res) => {
  const { token, data } = req.body;
  if (!token) return res.status(400).json({ error: 'tokenが必要です' });
  try {
    const result = await sheetsRequest('POST', '/values:batchUpdate', token, {
      valueInputOption: 'USER_ENTERED', data
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sheets/put', sheetsLimiter, async (req, res) => {
  const { token, range, values } = req.body;
  if (!token) return res.status(400).json({ error: 'tokenが必要です' });
  try {
    const result = await sheetsRequest('PUT',
      `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      token, { range, majorDimension: 'ROWS', values }
    );
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SPA フォールバック ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`StratTask running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠ ANTHROPIC_API_KEY 未設定');
  if (!process.env.GOOGLE_CLIENT_ID)  console.warn('⚠ GOOGLE_CLIENT_ID 未設定');
  if (!process.env.APP_USER)          console.warn('⚠ Basic認証未設定');
  else                                console.log('✓ Basic認証有効');
});
