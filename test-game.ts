import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/howe/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    headless: true,
  });
  const page = await browser.newPage();

  console.log('=== 斗地主游戏自动化测试 ===\n');

  // 1. 访问前端页面
  await page.goto('http://localhost:3000/');
  await page.waitForTimeout(1000);
  console.log('✅ 页面已打开');

  // 2. 注册新用户
  await page.fill('#phone', '13800000001');
  await page.fill('#password', 'test1234');
  await page.click('button:has-text("注册")');
  await page.waitForTimeout(500);
  console.log('✅ 注册完成');

  // 3. 登录
  await page.click('button:has-text("登录")');
  await page.waitForTimeout(500);
  console.log('✅ 登录成功');

  // 4. 创建房间
  await page.click('button:has-text("创建房间")');
  await page.waitForTimeout(500);
  console.log('✅ 房间创建完成');

  // 5. 加入房间
  await page.click('button:has-text("加入房间")');
  await page.waitForTimeout(500);
  console.log('✅ 已加入房间');

  // 6. 创建游戏
  await page.click('button:has-text("创建游戏")');
  await page.waitForTimeout(1000);
  console.log('✅ 游戏创建完成');

  // 等待游戏状态
  await page.waitForTimeout(2000);

  // 7. 抢地主 - 如果轮到玩家
  const bidSection = await page.isVisible('#bid-section');
  if (bidSection) {
    await page.waitForSelector('#bid-section button:enabled', { timeout: 5000 });
    await page.click('#bid-section button:has-text("抢地主")');
    await page.waitForTimeout(3000);
    console.log('✅ 抢地主完成');
  }

  // 8. 等待出牌阶段
  await page.waitForTimeout(2000);

  // 9. 出牌 - 如果轮到玩家
  const playSection = await page.isVisible('#play-section');
  if (playSection) {
    await page.waitForSelector('#play-section button:enabled', { timeout: 5000 });
    // 随机选择一张牌
    const cards = await page.$$('.hand-preview .card');
    if (cards.length > 0) {
      await cards[0].click();
      await page.click('#play-section button:has-text("出牌")');
      await page.waitForTimeout(3000);
      console.log('✅ 玩家出牌完成');
    }
  }

  // 10. 自动等待机器人回合
  await page.waitForTimeout(5000);
  console.log('⏳ 等待机器人出牌...');

  // 再次检查是否轮到玩家
  const playSection2 = await page.isVisible('#play-section');
  if (playSection2) {
    const cards2 = await page.$$('.hand-preview .card');
    if (cards2.length > 0) {
      await page.click('.hand-preview .card');
      await page.click('#play-section button:has-text("出牌")');
      await page.waitForTimeout(3000);
      console.log('✅ 第二轮出牌完成');
    }
  }

  // 11. 等待游戏结束
  await page.waitForTimeout(5000);

  // 12. 检查游戏结果
  const logContent = await page.textContent('#log');
  console.log('\n=== 游戏日志 ===');
  console.log(logContent);

  const status = await page.textContent('#status');
  console.log(`\n🎮 游戏状态: ${status}`);

  await browser.close();
  console.log('\n=== 测试完成 ===');
})();
