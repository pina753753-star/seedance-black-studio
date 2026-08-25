'use strict';

// バグ: 年額タブ選択時、Free/Standard/Premium/Ultimateは正しく「/年」表示に
// 切り替わるが、Teamだけ「¥298,000/月」の月額表示のまま変わらなかった。
//
// 原因: renderPlans()の年額分岐(billing==='annual')は、
//   1. p.annual を持つプラン(Standard/Premium/Ultimate) → 年額表示
//   2. p.cls==='free' → 初回クレジット表示
//   3. それ以外(1にも2にも該当しない) → ここが「月額プラン用」の
//      priceHtml/creditsHtml(p.monthly/p.period)をそのまま使っていた
// の3分岐しかなく、Teamはp.annualを持たずfreeでもないため3番目の
// 「それ以外」分岐に落ち、年額タブでも月額の金額・期間文字列
// (p.monthly='298,000', p.period='/月')がそのまま出力されていた。
//
// 修正: 3番目の分岐を「年額プランは準備中」の専用表示にし、月額の金額・
// 期間を年額タブで誤って見せないようにした。Teamの年額Stripe Priceは
// まだ存在しないため、¥298,000×12等の単純換算は行わず「準備中」を表示する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pricingHtml = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');

function loadRenderPlans({ billing }) {
  const plansStart = pricingHtml.indexOf('const plans=[');
  const plansEnd = pricingHtml.indexOf('\n', pricingHtml.indexOf('];', plansStart)) + 1;
  const plansSrc = pricingHtml.slice(plansStart, plansEnd);

  const fnStart = pricingHtml.indexOf('function isPurchaseDisabledPlan(');
  const fnEnd = pricingHtml.indexOf('function renderPacks(', fnStart);
  const fnSrc = pricingHtml.slice(fnStart, fnEnd);

  let capturedHtml = '';
  const context = {
    billing,
    shouldShowAnnualCampaignPrice: () => true,
    document: {
      querySelectorAll() { return []; }
    },
    plansEl: {
      set innerHTML(v) { capturedHtml = v; },
      get innerHTML() { return capturedHtml; }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${plansSrc}\n${fnSrc}\nthis.plans = plans;\nthis.renderPlans = renderPlans;\n`, context);
  context.renderPlans();

  // articleごとに分割して、プランclsでアクセスできるようにする
  const articles = {};
  for (const m of capturedHtml.matchAll(/<article class="plan ([a-z]+)">([\s\S]*?)<\/article>/g)) {
    articles[m[1]] = m[2];
  }
  return articles;
}

test('pricing.html: 月額タブではTeamは従来通り¥298,000/月を表示する(回帰確認)', () => {
  const articles = loadRenderPlans({ billing: 'monthly' });
  assert.match(articles.team, /298,000/);
  assert.match(articles.team, /\/月/);
});

test('pricing.html: 年額タブではTeamに月額の金額・期間(298,000 / 月)を出さない', () => {
  const articles = loadRenderPlans({ billing: 'annual' });
  assert.doesNotMatch(articles.team, /298,000/, '年額タブでTeamの月額金額が出てしまっています');
  assert.doesNotMatch(articles.team, />\/月</, '年額タブでTeamに月額の期間表記(/月)が出てしまっています');
  assert.match(articles.team, /準備中/);
});

test('pricing.html: 年額タブでもTeamボタンの「準備中」ラベルとdisabled属性は維持される', () => {
  const articles = loadRenderPlans({ billing: 'annual' });
  assert.match(articles.team, /<button class="btn btnDisabled" data-plan="team" disabled aria-disabled="true">準備中<\/button>/);
});

test('pricing.html: 年額タブでのStandard/Premium/Ultimateの表示(10%OFF・年間クレジット)はTeam修正後も変化しない', () => {
  const articles = loadRenderPlans({ billing: 'annual' });
  for (const cls of ['standard', 'premium', 'ultimate']) {
    assert.match(articles[cls], /\/年/, `${cls}に/年表示がありません`);
    assert.match(articles[cls], /期間限定10%OFF/, `${cls}に期間限定10%OFF表示がありません`);
    assert.match(articles[cls], /年間合計クレジット/, `${cls}に年間合計クレジット表示がありません`);
  }
});

test('pricing.html: 月額タブでのStandard/Premium/Ultimate/Freeの表示はTeam修正後も変化しない', () => {
  const articles = loadRenderPlans({ billing: 'monthly' });
  assert.match(articles.free, /初回クレジット/);
  assert.match(articles.standard, /2,980/);
  assert.match(articles.premium, /6,980/);
  assert.match(articles.ultimate, /15,800/);
  for (const cls of ['standard', 'premium', 'ultimate']) {
    assert.match(articles[cls], />\/月</);
  }
});
