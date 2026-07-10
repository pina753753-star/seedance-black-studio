const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || 'hinaran53@gmail.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

function notFound(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(404).send('Not Found');
}

function getBearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function renderPage(email) {
  const safeEmail = String(email || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>FlowVid AI Aquarium | 管理者専用</title>
<meta name="theme-color" content="#071b38">
<style>
:root{--bg:#061326;--ink:#f7fcff;--muted:rgba(230,247,255,.72);--glass:rgba(8,34,68,.78);--glass2:rgba(11,45,87,.9);--line:rgba(143,224,255,.28);--cyan:#86eeff;--violet:#a88dff;--gold:#ffe08a;--green:#a8ffd7;--red:#ffc3d0;--shadow:0 18px 60px rgba(0,0,0,.32)}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-x:hidden}body:before,body:after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none}body:before{background:radial-gradient(circle at 8% 7%,rgba(134,238,255,.30),transparent 23%),radial-gradient(circle at 86% 2%,rgba(168,141,255,.24),transparent 28%),radial-gradient(circle at 50% 110%,rgba(168,255,215,.16),transparent 34%),linear-gradient(180deg,#071225 0%,#0a2d59 46%,#061326 100%)}body:after{background-image:radial-gradient(circle,rgba(255,255,255,.18) 1px,transparent 1.6px);background-size:30px 30px;opacity:.22}.app{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:10px 10px 44px}.top{position:sticky;top:0;z-index:50;margin:0 -10px 10px;padding:10px 12px;display:flex;align-items:center;gap:10px;justify-content:space-between;background:rgba(5,18,36,.78);backdrop-filter:blur(18px);border-bottom:1px solid rgba(143,224,255,.18)}.brand{display:flex;gap:10px;align-items:center;min-width:0}.logo{width:44px;height:44px;min-width:44px;border-radius:17px;background:radial-gradient(circle at 32% 28%,#fff 0 8px,transparent 9px),linear-gradient(135deg,var(--cyan),#77a9ff,var(--violet));box-shadow:0 0 34px rgba(134,238,255,.26)}.brand small{display:block;color:rgba(238,249,255,.52);font-size:8px;letter-spacing:.22em}.brand b{display:block;font-size:18px;letter-spacing:-.03em}.status{border:1px solid var(--line);background:rgba(255,255,255,.07);border-radius:999px;padding:8px 10px;font-size:10px;font-weight:900}.hero{display:grid;gap:12px;margin:8px 0 10px}.heroCard,.notice,.card,.map,.tank{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:26px;box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.07)}.heroCard{padding:18px 16px;background:linear-gradient(135deg,rgba(23,97,151,.78),rgba(15,55,103,.9) 55%,rgba(71,55,138,.8))}.heroCard:after{content:"🐬  🐋  🪼";position:absolute;right:18px;bottom:12px;font-size:26px;opacity:.78;letter-spacing:6px}.kicker{margin:0;color:#d9fbff;font-size:11px;font-weight:1000;letter-spacing:.18em}.hero h1{margin:7px 0 8px;font-size:33px;line-height:1.04;letter-spacing:-.06em;background:linear-gradient(135deg,#fff,#b9f3ff 56%,#ffd8f0);-webkit-background-clip:text;color:transparent}.lead{margin:0;color:rgba(246,253,255,.78);font-size:13px;line-height:1.7}.notice{padding:12px;background:linear-gradient(180deg,rgba(8,38,74,.78),rgba(7,25,50,.96));font-size:12px;line-height:1.6}.notice b{display:block;margin-bottom:3px}.tabs{position:sticky;top:64px;z-index:45;display:flex;gap:8px;overflow-x:auto;margin:0 -2px 10px;padding:8px 2px 10px;background:linear-gradient(180deg,rgba(6,19,38,.97),rgba(6,19,38,.70));backdrop-filter:blur(14px);scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}.tab{flex:0 0 auto;border:1px solid rgba(143,224,255,.20);background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.045));color:#ecfbff;border-radius:999px;padding:10px 12px;font-size:12px;font-weight:950;white-space:nowrap}.tab.active{border-color:rgba(134,238,255,.55);background:linear-gradient(135deg,rgba(134,238,255,.28),rgba(168,141,255,.20));box-shadow:0 0 24px rgba(134,238,255,.16)}.panel{display:none}.panel.active{display:block}.grid{display:grid;gap:10px}.card,.map,.tank{padding:14px;background:linear-gradient(180deg,var(--glass),var(--glass2))}.titleRow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.titleRow h2{font-size:20px;margin:0}.tag{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);border-radius:999px;padding:5px 8px;font-size:10px;font-weight:1000;color:#fff5bf}.alerts,.rows,.safeList{display:grid;gap:8px}.alert,.row,.safeRow{display:flex;justify-content:space-between;gap:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);border-radius:16px;padding:10px;font-size:12px}.badge{border-radius:999px;padding:4px 8px;font-size:10px;font-weight:1000;border:1px solid rgba(255,255,255,.18)}.danger{color:var(--red)}.warn{color:var(--gold)}.safe{color:var(--green)}.quick{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.quickItem{border:1px solid rgba(143,224,255,.18);border-radius:20px;padding:12px;background:rgba(255,255,255,.05)}.quickItem b{display:block;font-size:28px}.quickItem span{display:block;margin-top:7px;font-size:11px;color:var(--muted)}.mapLead{margin:-4px 0 12px;color:var(--muted);font-size:12px;line-height:1.55}.zoneGrid{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:10px}.zone{position:relative;overflow:hidden;border:1px solid rgba(143,224,255,.22);border-radius:24px;padding:12px;min-height:128px;background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.035))}.zone.main{grid-row:span 2}.zoneLabel{display:inline-flex;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.10);border-radius:999px;padding:5px 9px;font-size:10px;font-weight:1000}.zone h3{margin:9px 0 4px;font-size:17px}.zone p{margin:0;max-width:72%;font-size:11px;line-height:1.45;color:var(--muted)}.fish{position:absolute;right:12px;top:48%;font-size:30px;animation:float 7s ease-in-out infinite}.fish.big{font-size:42px}.fish.two{right:58px;top:30%;animation-delay:-2s}.fish.small{font-size:20px}.fish.left{left:18px;right:auto;top:60%}.sand{position:absolute;left:0;right:0;bottom:0;height:26px;background:linear-gradient(180deg,transparent,rgba(255,205,138,.22))}.eel{position:absolute;bottom:8px;width:10px;height:38px;border-radius:999px;background:linear-gradient(180deg,#fff3c6,#d79854);animation:peek 2.8s ease-in-out infinite}.e1{left:24%}.e2{left:40%;height:28px;animation-delay:-1.1s}.e3{left:58%;height:42px;animation-delay:-1.8s}.e4{left:74%;height:31px;animation-delay:-.7s}@keyframes float{0%,100%{transform:translate(0,0)}50%{transform:translate(-12px,-8px)}}@keyframes peek{0%,100%{transform:translateY(22px)}50%{transform:translateY(0)}}.tankHero{min-height:250px;border:1px solid rgba(143,224,255,.20);border-radius:24px;background:rgba(255,255,255,.04);position:relative;overflow:hidden;padding:16px}.tankText{max-width:76%}.tankText h2{font-size:26px;margin:0 0 8px}.tankText p{font-size:13px;line-height:1.65;color:var(--muted);margin:0}.row{font-size:13px}.row strong{font-size:16px}.ok strong{color:var(--green)}.bad strong{color:var(--red)}.mid strong{color:var(--gold)}.safeRow{display:block;color:#ddfbef;background:rgba(75,182,139,.09)}.foot{color:rgba(223,243,255,.44);font-size:12px;text-align:center;margin:18px 0 0}@media(min-width:780px){.hero{grid-template-columns:1fr 340px}.grid{grid-template-columns:1fr 1fr}.map{grid-column:1/-1}}@media(max-width:850px){.zoneGrid{grid-template-columns:1fr 1fr}}@media(max-width:560px){.hero h1{font-size:31px}.quick{grid-template-columns:repeat(2,minmax(0,1fr))}.zoneGrid{grid-template-columns:1fr}.zone.main{grid-row:auto}.zone{min-height:138px}.brand b{font-size:17px}.status{font-size:9px}}
</style>
</head>
<body>
<div class="app">
<header class="top"><div class="brand"><div class="logo"></div><div><small>AI VIDEO AQUARIUM</small><b>FlowVid Studio</b></div></div><div class="status">管理者専用</div></header>
<section class="hero"><article class="heroCard"><p class="kicker">FLOWVID AI AQUARIUM MOCK</p><h1>AIカンパニー<br>運営水族館</h1><p class="lead">生成・編集・決済・インフラ・セキュリティ・案内・開発を見渡す管理者専用モック。</p></article><aside class="notice"><b>管理者: ${safeEmail}</b>実データ連携なし。操作ボタンなし。数字は表示確認用の仮データです。</aside></section>
<nav class="tabs"><button class="tab active" data-tab="map">館内マップ</button><button class="tab" data-tab="gen">🪼 生成</button><button class="tab" data-tab="edit">🐙 編集</button><button class="tab" data-tab="pay">🐬 決済</button><button class="tab" data-tab="infra">🐟 インフラ</button><button class="tab" data-tab="security">🦈 警備</button><button class="tab" data-tab="customer">🐧 案内</button><button class="tab" data-tab="dev">チンアナゴ</button></nav>
<section class="panel active" id="panel-map"><div class="grid"><article class="card"><div class="titleRow"><h2>お知らせ</h2><span class="tag">NOTICE</span></div><div class="alerts"><div class="alert"><span>生成エラーが3件あります</span><span class="badge danger">確認</span></div><div class="alert"><span>編集エラーは生成エラーと別集計です</span><span class="badge warn">分離済み</span></div><div class="alert"><span>新規生成テストは禁止中です</span><span class="badge safe">安全</span></div></div></article><article class="card"><div class="titleRow"><h2>本日の館内サマリー</h2><span class="tag">TODAY</span></div><div class="quick"><div class="quickItem"><b>24</b><span>生成リクエスト</span></div><div class="quickItem"><b>18</b><span>正常完了</span></div><div class="quickItem"><b>3</b><span>生成エラー</span></div><div class="quickItem"><b>2</b><span>編集エラー</span></div></div></article><article class="map"><div class="titleRow"><h2>館内マップ</h2><span class="tag">AQUARIUM</span></div><p class="mapLead">部署を水槽エリアに変換。大型魚、小魚、ペンギン、チンアナゴで役割を分けています。</p><div class="zoneGrid"><div class="zone main"><span class="zoneLabel">大回遊水槽</span><h3>決済</h3><p>サブスク・追加クレジット・credits。</p><span class="fish big">🐬</span><span class="fish big two">🐋</span></div><div class="zone"><span class="zoneLabel">発光クラゲ</span><h3>生成</h3><p>Seedance / OpenRouter / pending</p><span class="fish">🪼</span></div><div class="zone"><span class="zoneLabel">タコ工房</span><h3>動画編集</h3><p>カット・テロップ・結合</p><span class="fish big">🐙</span></div><div class="zone"><span class="zoneLabel">水質管理室</span><h3>インフラ</h3><p>Vercel / Supabase / Storage</p><span class="fish small">🐠</span><span class="fish small left">🐟</span></div><div class="zone"><span class="zoneLabel">サメ警備室</span><h3>セキュリティ</h3><p>認証・管理者・APIキー</p><span class="fish big">🦈</span></div><div class="zone"><span class="zoneLabel">ペンギン案内</span><h3>カスタマー</h3><p>料金案内・クレジット不足</p><span class="fish">🐧</span></div><div class="zone"><span class="zoneLabel">繁殖・育成</span><h3>開発</h3><p>PR・モック・改善タスク</p><div class="sand"></div><span class="eel e1"></span><span class="eel e2"></span><span class="eel e3"></span><span class="eel e4"></span></div></div></article><article class="card"><div class="titleRow"><h2>安全ルール</h2><span class="tag">SAFE</span></div><div class="safeList"><div class="safeRow">外部APIを呼びません。</div><div class="safeRow">Supabase DBを読み書きしません。</div><div class="safeRow">OpenRouterに接続しません。</div><div class="safeRow">creditsを消費しません。</div><div class="safeRow">新規動画生成を実行しません。</div></div></article></div></section>
<section class="panel" id="panel-gen"><article class="tank"><div class="tankHero"><div class="tankText"><h2>発光クラゲ生成室</h2><p>Seedance / OpenRouterの状態を表示するモック。</p></div><span class="fish big">🪼</span></div><div class="rows"><div class="row ok"><span>completed</span><strong>18</strong></div><div class="row mid"><span>pending / processing</span><strong>3</strong></div><div class="row bad"><span>生成エラー</span><strong>3</strong></div></div></article></section>
<section class="panel" id="panel-edit"><article class="tank"><div class="tankHero"><div class="tankText"><h2>タコ編集工房</h2><p>編集エラーは生成エラーと分離して表示。</p></div><span class="fish big">🐙</span></div><div class="rows"><div class="row mid"><span>編集待ち</span><strong>4</strong></div><div class="row"><span>編集中</span><strong>1</strong></div><div class="row ok"><span>編集完了</span><strong>8</strong></div><div class="row bad"><span>編集エラー</span><strong>2</strong></div></div></article></section>
<section class="panel" id="panel-pay"><article class="tank"><div class="tankHero"><div class="tankText"><h2>大回遊決済水槽</h2><p>サブスク、追加クレジット、creditsの流れを表示。</p></div><span class="fish big">🐬</span><span class="fish big two">🐋</span></div><div class="rows"><div class="row"><span>credits消費</span><strong>1,320</strong></div><div class="row ok"><span>返金</span><strong>110</strong></div><div class="row mid"><span>残高不足</span><strong>2</strong></div></div></article></section>
<section class="panel" id="panel-infra"><article class="tank"><div class="tankHero"><div class="tankText"><h2>水質・濾過管理室</h2><p>Vercel、Supabase、Storage、Railwayのモック。</p></div><span class="fish small">🐠</span><span class="fish small two">🐟</span></div><div class="rows"><div class="row ok"><span>Supabase保存成功</span><strong>17</strong></div><div class="row bad"><span>404 URL</span><strong>1</strong></div><div class="row mid"><span>storage_urlなし</span><strong>1</strong></div></div></article></section>
<section class="panel" id="panel-security"><article class="tank"><div class="tankHero"><div class="tankText"><h2>サメ警備室</h2><p>認証、管理者権限、APIキーを見張るモック。</p></div><span class="fish big">🦈</span></div><div class="rows"><div class="row ok"><span>管理者ログイン</span><strong>保護</strong></div><div class="row ok"><span>APIキー表示</span><strong>なし</strong></div><div class="row mid"><span>本番操作</span><strong>承認制</strong></div></div></article></section>
<section class="panel" id="panel-customer"><article class="tank"><div class="tankHero"><div class="tankText"><h2>ペンギン案内所</h2><p>ユーザー案内、料金ページ誘導、クレジット不足のモック。</p></div><span class="fish">🐧</span></div><div class="rows"><div class="row"><span>クレジット不足案内</span><strong>2</strong></div><div class="row ok"><span>料金ページ誘導</span><strong>表示</strong></div></div></article></section>
<section class="panel" id="panel-dev"><article class="tank"><div class="tankHero"><div class="tankText"><h2>繁殖・育成コーナー</h2><p>チンアナゴと小魚の開発モック。</p></div><div class="sand"></div><span class="eel e1"></span><span class="eel e2"></span><span class="eel e3"></span><span class="eel e4"></span></div><div class="rows"><div class="row ok"><span>モックPR</span><strong>#47</strong></div><div class="row"><span>実データ連携</span><strong>未実装</strong></div><div class="row"><span>操作ボタン</span><strong>なし</strong></div></div></article></section>
<p class="foot">Protected admin mock. No production data. No write actions.</p>
</div>
<script>const tabs=[...document.querySelectorAll('.tab')],panels=[...document.querySelectorAll('.panel')];function showTab(name){tabs.forEach(t=>t.classList.toggle('active',t.dataset.tab===name));panels.forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));}tabs.forEach(t=>t.addEventListener('click',()=>showTab(t.dataset.tab)));</script>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return notFound(res);
  }

  const token = getBearerToken(req);
  if (!token || !SUPABASE_URL || !SUPABASE_KEY) return notFound(res);

  try {
    const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await client.auth.getUser(token);
    const email = String(data?.user?.email || '').toLowerCase();
    if (error || !email || !ADMIN_EMAILS.has(email)) return notFound(res);

    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(renderPage(email));
  } catch (_) {
    return notFound(res);
  }
};
