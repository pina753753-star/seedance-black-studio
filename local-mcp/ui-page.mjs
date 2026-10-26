import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('./ui-theme.css',import.meta.url),'utf8');
const digest=createHash('sha256').update(css).digest('base64');
export function uiPolicy(origin){return `default-src 'none'; style-src 'sha256-${digest}'; img-src ${new URL('/assets/brand/pina-logo-header-full.png',origin).href}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;}
export function uiPage({title,step=2,body}){
 const steps=['ログイン','接続を確認','ChatGPTへ戻る'].map((s,i)=>`<li${i+1===step?' aria-current="step"':''}>${i+1}. ${s}</li>`).join('');
 return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Pina Studio</title><style>${css}</style></head><body><main><img class="brand" src="/assets/brand/pina-logo-header-full.png" alt="Pina Studio"><ol class="steps" aria-label="接続の手順">${steps}</ol><section class="card">${body}</section><footer>Pina Studio と ChatGPT の接続</footer></main></body></html>`;
}
