/**
 * 支付片：桥接页 HTML 渲染（纯函数、零依赖）。
 *
 * `renderCashierPage` 产出的页面把已签名的 wap.pay 表单渲染成隐藏表单并**自动 POST** 到
 * 支付宝网关——这是支付宝官方对接的标准页面形态（页面执行型接口由浏览器执行）：
 *  - `Referrer-Policy: no-referrer`：桥接 URL 带能力 token，跳转支付宝时不泄漏 Referer；
 *  - 所有插值过 `escapeHtml`（属性用双引号包裹，转义 `"`/`'`/`<`/`>`/`&`）；
 *  - `<noscript>` 提供手动提交按钮（禁用脚本时链路仍可达）。
 * 响应侧另设 `Cache-Control: no-store`（控制器下发），token 页不入中间缓存。
 */

/** 桥接页入参：网关地址 + 已签名表单字段（含 sign）。 */
export interface CashierPageModel {
  gatewayUrl: string;
  fields: Record<string, string>;
}

/** 收银台桥接页（自动提交）。 */
export function renderCashierPage(model: CashierPageModel): string {
  const action = escapeHtml(model.gatewayUrl);
  const inputs = Object.entries(model.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n    ');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>正在跳转支付宝收银台…</title>
<style>
  body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6fa;color:#1f2329}
  .box{max-width:420px;margin:18vh auto 0;text-align:center;padding:0 24px}
  .spin{width:42px;height:42px;margin:0 auto 20px;border:4px solid #d9dce3;border-top-color:#1677ff;border-radius:50%;animation:c 0.9s linear infinite}
  @keyframes c{to{transform:rotate(360deg)}}
  h1{font-size:18px;font-weight:600;margin:0 0 8px}
  p{font-size:14px;color:#646a73;line-height:1.6;margin:0}
  button{margin-top:22px;padding:10px 26px;font-size:15px;color:#fff;background:#1677ff;border:0;border-radius:8px}
</style>
</head>
<body>
<form id="pay" method="post" action="${action}">
    ${inputs}
    <noscript>
      <div class="box">
        <h1>即将前往支付宝完成付款</h1>
        <p>脚本未启用，请点击下方按钮继续。</p>
        <button type="submit">前往支付宝</button>
      </div>
    </noscript>
</form>
<div class="box" id="tip">
  <div class="spin"></div>
  <h1>正在跳转支付宝收银台…</h1>
  <p>如未自动跳转，请确认浏览器允许跳转，或重新从订单页发起支付。</p>
</div>
<script>document.forms[0].submit();</script>
</body>
</html>`;
}

/** 404/410/502 等终态的极简中文提示页。 */
export function renderCashierMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6fa;color:#1f2329}
  .box{max-width:420px;margin:18vh auto 0;text-align:center;padding:0 24px}
  h1{font-size:18px;font-weight:600;margin:0 0 8px}
  p{font-size:14px;color:#646a73;line-height:1.6;margin:0}
</style>
</head>
<body>
<div class="box">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</div>
</body>
</html>`;
}

/** HTML 文本/属性统一转义（白名单字符直出，其余按实体）。 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
