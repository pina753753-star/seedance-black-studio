'use strict';

// Teamプランを年額も購入可能にしたことに伴い、renderPlans()の年額表示は
// Standard/Premium/Ultimateと同じ分岐(p.annualを持つプラン向けの表示)を
// そのまま通るようになった。以前は「p.annualを持たないプラン向け」の
// 分岐に落ちて月額表示(¥298,000/月)のまま切り替わらないバグがあったが、
// 今回Teamにannual/campaignAnnual/annualCreditsを追加したことで解消した。
//
// このファイルは、Team年額の実際の表示内容(通常価格・期間限定10%OFF・
// 年間合計クレジット)と、月額表示が従来通りであることを検証する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pricingHtml = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');

function loadRenderPlans({ billing, campaignActive = true }) {
  const plansStart = pricingHtml.indexOf('const plans=[');
  const plansEnd = pricingHtml.indexOf('\n', pricingHtml.indexOf('];', plansStart)) + 1;
  const plansSrc = pricingHtml.slice(plansStart, plansEnd);

  const fnStart = pricingHtml.indexOf('function isPurchaseDisabledPlan(');
  const fnEnd = pricingHtml.indexOf('function renderPacks(', fnStart);
  const fnSrc = pricingHtml.slice(fnStart, fnEnd);

  let capturedHtml = '';
  const context = {
    billing,
    shouldShowAnnualCampaignPrice: () => campaignActive,
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

test('pricing.html: 年額タブではTeamも他プランと同様に「/年」表示に切り替わる', () => {
  const articles = loadRenderPlans({ billing: 'annual', campaignActive: true });
  assert.match(articles.team, /\/年/);
  assert.doesNotMatch(articles.team, />\/月</, '年額タブでTeamに月額の期間表記(/月)が残っています');
});

test('pricing.html: 年額タブ・キャンペーン期間内はTeamにも期間限定10%OFF(¥3,218,400)が表示される', () => {
  const articles = loadRenderPlans({ billing: 'annual', campaignActive: true });
  assert.match(articles.team, /3,218,400/);
  assert.match(articles.team, /期間限定10%OFF/);
  // 通常価格(¥3,576,000)は取り消し線付きで併記される。
  assert.match(articles.team, /3,576,000/);
});

test('pricing.html: 年額タブ・キャンペーン終了後(または未設定)はTeamも通常価格(¥3,576,000)のみ表示する', () => {
  const articles = loadRenderPlans({ billing: 'annual', campaignActive: false });
  assert.match(articles.team, /3,576,000/);
  assert.doesNotMatch(articles.team, /3,218,400/);
  assert.doesNotMatch(articles.team, /期間限定10%OFF/);
});

test('pricing.html: 年額タブのTeamは年間合計クレジット1,080,000・毎月90,000付与を表示する', () => {
  const articles = loadRenderPlans({ billing: 'annual', campaignActive: true });
  assert.match(articles.team, /年間合計クレジット/);
  assert.match(articles.team, /1,080,000/);
  assert.match(articles.team, /毎月 90,000 credits付与/);
});

test('pricing.html: 年額タブでもCreator Proのボタンは「購入する」で、disabled/準備中表示にはならない', () => {
  const articles = loadRenderPlans({ billing: 'annual', campaignActive: true });
  assert.match(articles.team, /<h2 class="name">Creator Pro<\/h2>/);
  assert.match(articles.team, /<button class="btn" data-plan="team">購入する<\/button>/);
  assert.doesNotMatch(articles.team, /disabled/);
  assert.doesNotMatch(articles.team, /準備中/);
});

test('pricing.html: 年額タブでのStandard/Premium/Ultimateの表示(10%OFF・年間クレジット)はTeam年額対応後も変化しない', () => {
  const articles = loadRenderPlans({ billing: 'annual', campaignActive: true });
  for (const cls of ['standard', 'premium', 'ultimate']) {
    assert.match(articles[cls], /\/年/, `${cls}に/年表示がありません`);
    assert.match(articles[cls], /期間限定10%OFF/, `${cls}に期間限定10%OFF表示がありません`);
    assert.match(articles[cls], /年間合計クレジット/, `${cls}に年間合計クレジット表示がありません`);
  }
});

test('pricing.html: 月額タブでのStandard/Premium/Ultimate/Freeの表示はTeam年額対応後も変化しない', () => {
  const articles = loadRenderPlans({ billing: 'monthly' });
  assert.match(articles.free, /初回クレジット/);
  assert.match(articles.standard, /2,980/);
  assert.match(articles.premium, /6,980/);
  assert.match(articles.ultimate, /15,800/);
  for (const cls of ['standard', 'premium', 'ultimate']) {
    assert.match(articles[cls], />\/月</);
  }
});
