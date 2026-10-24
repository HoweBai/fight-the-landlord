/**
 * 素材槽（片② spec §3.5 / R733；判据形态见 §5.2「素材槽」行，H4 订正后）。
 *
 * ⚠️ **判据射程（诚实版）**：这里**不**证明「有图时贴得对不对」（那是观感，只能走查）。
 * 它证明两件**可以机械判定**的事：
 *  ① **每个槽都被显式登记**（`EXPECTED_SLOT_VALUES` 逐槽写死 `none` 或 `url(...)`）——
 *     「素材到位 / 还没到位」这件事是**显式**的，不是忘了（形态变迁见下面那段说明）；
 *  ② **用了槽位的组件不得再用 `url(...)` 形式硬编码 `/static/ui/` 路径**绕过槽位 ——
 *     这才是真正的判别力所在：绕过槽位直接写 `url('/static/ui/xxx.png')` 会让「换素材只改一行」
 *     的承诺**静默失效**，而单测与探针都看不见（图上去了、页面也没报错）。
 *
 *     ⚠️ **射程的诚实化（B5 遗留 Minor 2）**：本闸只认 `url(...)` 形态（**引号可选** ——
 *     初稿要求带引号，`url(/static/ui/x.png)` 能溜过去，已放宽）；模板里的
 *     `<image src="/static/ui/…">` 是**另一条通道**（图标类素材走它，`PlayerChip.vue` /
 *     `MoreMenu.vue` 的文件头写明「不走槽位」），本闸**不管**它，也**不该**管：
 *     槽位机制是 CSS `background-image` 的，`<image>` 的 `src` 吃不到 SCSS 令牌。
 *
 * ⚠️ **H4 订正**：初稿的判据写的是「令牌为 none ⇒ 无 `background-image`」—— 那是**错的**：
 * 组件里逐字就是 `background-image: $ftl-art-x`，那个词**永远在**。真正的判据在上面两条。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
const uniScss = stripComments(sources.find((f) => f.path === 'src/uni.scss')!.content);

/** spec §3.5 逐槽登记的那几个（少一个就说明槽被悄悄删了）。 */
const SLOTS = [
  'ftl-art-landlord-badge',
  'ftl-art-count-tile',
  'ftl-art-count-tile-warn',
  'ftl-art-coin',
  'ftl-art-avatar-ring',
  'ftl-art-bid-badge',
  'ftl-art-countdown',
  'ftl-art-bottom-bar',
  'ftl-art-settlement-ribbon',
] as const;

/** 取一个令牌的真值（未找到返回 null）。 */
function tokenValue(name: string): string | null {
  const m = new RegExp(`^\\$${name}:\\s*([^;]+);`, 'm').exec(uniScss);
  return m ? m[1]!.trim() : null;
}

describe('§3.5 素材槽（R733：CSS 兜底 + 可选贴图）', () => {
  /**
   * ⚠️ **判据形态的变迁**（片③ 阶段 B）：原形态是「七槽缺省值全是 `none`」，
   * 它的射程是「素材还没到位这件事是**显式**的，不是忘了」。片③ 新增了第 8 槽
   * （`settlement-ribbon` **有图** ⇒ 值不再是 `none`）⇒ 原形态必然红。
   *
   * 新形态守住**同一个性质**：**每个槽都必须被显式登记**（`EXPECTED_SLOT_VALUES`
   * 逐槽写死 `none` 或 `url(...)`）—— 加一个槽不登记、或把已有的槽悄悄改成 `none`
   * 都会当场红。这比原形态**更强**：原形态只要求「全是 none」，新形态要求
   * 「每一个都等于**我们说好的那个值**」。
   *
   * ⚠️ `coin` 的**终态是 `url(...)`**（`dou.png` 早已入库）—— B5 先登记为 `none`（一次只改一处），
   * **Task B6 已接通**：值与 `uni.scss` 同步翻成 `url(...)`；把它**改回 `none`** 是「最像正确答案的
   * 那个错」（“还没轮到我接图”）⇒ 本表当场红（B6 变异 M1 自证）。
   *
   * ⚠️ `countdown` 的值经历过「接通 → 退回 `none` → 再次接通」：B6 曾用宽胶囊
   * `jishianniudi.png` 接通，用户 2026-09-29 裁决**不接**（形状不匹配）⇒ 退回 `none`；
   * A′ 档合形素材 `countdown.png`（200×200 闹钟）到位后**重新接通为 `url(...)`**。
   * 现在把它改回 `none` 或换掉路径，同样当场红（当前约定值的机器形态）。
   */
  const EXPECTED_SLOT_VALUES: Record<(typeof SLOTS)[number], string> = {
    // A′ 档六张素材接通（2026-06）：六个 'none' 全部翻成 url(...)，与 uni.scss 同行同步。
    'ftl-art-landlord-badge': "url('/static/ui/landlord-badge.png')", // 112×197 竖牌；「地主」已画进图 ⇒ 消费点不画 DOM 文字
    // 版本 query 统一走 ftl-asset-url()（dev 无 query / 生产 ?v=版本，见 uni.scss 顶部）；
    // 断言锁**源码形态**（函数包裹），不锁运行期 URL，避免每次发版改测试。
    // 2026-10-12：常态换冷蓝（融入冷蓝牌桌），暖橙旧图下移到 warn 槽只在报单/报双出现
    'ftl-art-count-tile': "url(ftl-asset-url('/static/ui/count-tile.png'))", // 冷蓝牌（2026-10-12 第三次重换）⇒ 容器 36×49
    'ftl-art-count-tile-warn': "url(ftl-asset-url('/static/ui/count-tile-warn.png'))", // 96×132 @2x 预警牌（2026-10-12 重换），仅 --warn
    'ftl-art-coin': "url('/static/ui/dou.png')", // Task B6 接通（51×51，正方形 ⇒ 容器 28×28 无变形）
    'ftl-art-avatar-ring': "url('/static/ui/avatar-ring.png')", // 256×256 正方形圆环
    'ftl-art-bid-badge': "url('/static/ui/bid-badge.png')", // 200×110 白瓷横牌 + 橙金内框
    'ftl-art-countdown': "url('/static/ui/countdown.png')", // 200×200 闹钟（旧 jishianniudi 不接裁决已被新素材满足）
    'ftl-art-bottom-bar': 'none', // 619×122 胶囊；2026-10-11 第七轮起无消费点（HUD 去底）；2026-10-12 素材删除，槽置 none
    'ftl-art-settlement-ribbon': "url('/static/ui/jujsidai.png')", // 片③ 新增（B5 接通）
  };

  it('九个槽都被**显式登记**，且值逐槽等于约定值（`none` 或 `url(...)`）', () => {
    for (const slot of SLOTS) {
      const v = tokenValue(slot);
      expect(v, `未找到素材槽令牌 $${slot}`).not.toBeNull();
      expect(v, `$${slot} 与约定值不一致`).toBe(EXPECTED_SLOT_VALUES[slot]);
    }
  });

  /**
   * 🔴 **B5 遗留 Minor 1（堵老洞）**：上面那段注释此前声称「加一个槽不登记……会当场红」，
   * 但那句话的机器射程**更窄** —— 把 `$ftl-art-x: …` 加进 `uni.scss` 而**不动 `SLOTS`**，
   * 旧机器一条都不会红（逐槽断言只遍历 `SLOTS` 里写死的那些，新槽对它是隐形的）。
   *
   * 本用例把洞堵上：`uni.scss` 里**全部** `$ftl-art-*` 定义与 `SLOTS` **集合相等** ——
   * 两个方向都拦（加了槽不登记 ⇒ 红；登记了却没定义 ⇒ 上面第一条红）。
   * 顺带用长度断言拦「同名定义两遍」（集合相等看不见重复）。
   */
  it('`SLOTS` 与 `uni.scss` 里的槽定义**集合相等**（加槽不登记 / 同名两遍 都会红）', () => {
    const defined = [...uniScss.matchAll(/^\$ftl-art-[\w-]+:/gm)].map((m) => m[0]!.slice(1, -1));
    expect(defined.length, '`$ftl-art-*` 同名定义两遍也算异常（集合相等看不见重复）').toBe(
      SLOTS.length,
    );
    expect(new Set(defined), 'uni.scss 里的槽定义与 SLOTS 必须逐名相等').toEqual(new Set(SLOTS));
  });

  it('令牌只能取 none 或 url(...)（**连 url() 一起存** —— url(none) 非法、整条声明会被静默丢弃）', () => {
    for (const slot of SLOTS) {
      const v = tokenValue(slot)!;
      expect(
        v === 'none' || v.startsWith('url('),
        `$${slot} 只能取 none 或 url(...)，实为「${v}」`,
      ).toBe(true);
    }
    // 反面对照：**路径式**（既有 `$ftl-btn-plate` 那批的约定）在本段**不合法** ——
    // 因为它放不下「还没有素材」这个状态。这条正反对照就是「为什么两套约定」的机械表述。
    expect(tokenValue('ftl-btn-plate'), '既有的路径式令牌仍是路径（不受本段约束）').toMatch(/^'/);
  });

  /**
   * 判别力所在：**槽位体系内部必须一致**。
   *
   * ⚠️ 规则是「**组件一旦用了至少一个 `$ftl-art-*` 槽位，就不得再用 `url(...)` 形式硬编码
   * `/static/ui/` 字面路径**」，**不是**「全仓禁字面路径」、也**不是**「禁一切字面路径」。
   * 后两条措辞都被事实否掉：
   *  · 全仓层面 —— 初稿的写法当场命中两处**结构性**的既有写法，而它们**各自有独立判据**盯着：
   *    `LandscapeStage.vue` 的底纹（片① R713：底纹**只铺一层**，判据
   *    `landscape-canvas.test.ts` 断言「铺底纹的写法」命中文件**恰好是它** ⇒ 不能挪进 `uni.scss`；
   *    ⚠️ 该判据 2026-09-29（Task B7）由「`bg.png` 只出现一次」改成「铺底纹的写法只允许在这里」，
   *    性质不变、形态变了 —— 这句引用**跟着改**，别让它悄悄过期）、
   *    `Panel.vue` 的 9-slice（`panel.test.ts` 断言四个切片参数在**源码里**齐备）；
   *  · `url(...)` 之外 —— 模板的 `<image src="/static/ui/…">` 是**图标类素材的另一条通道**
   *    （`PlayerChip.vue` / `MoreMenu.vue` 文件头写明「不走 `$ftl-art-*` 槽位」，因为槽位是
   *    CSS `background-image` 的机制，`src` 吃不到 SCSS 令牌）⇒ 本闸**不**覆盖它，
   *    注释也不再声称覆盖（B5 遗留 Minor 2：把注释改到与机器同宽）。
   *
   * 两处零槽位 ⇒ 在新规则下自然豁免，**不需要白名单**（白名单会腐烂）。
   */
  it('判别力：用了槽位的组件，不得再硬编码 /static/ui/ 路径（槽位体系内部一致）', () => {
    /** 绕过形态：`url(...)` 里的 `/static/ui/` 字面路径 —— **引号可选**（B5 遗留 Minor 2 放宽）。 */
    const BYPASS = /url\(\s*['"]?\/static\/ui\//;
    const usesSlot = (code: string) => /\$ftl-art-/.test(code);
    const offenders = sources
      .filter((f) => f.path.endsWith('.vue'))
      .map((f) => ({ path: f.path, code: stripComments(f.content) }))
      .filter((f) => usesSlot(f.code) && BYPASS.test(f.code))
      .map((f) => f.path);
    expect(
      offenders,
      '用了 $ftl-art-* 槽位的组件里，素材一律走槽位 —— 不得再写字面 /static/ui/ 路径',
    ).toEqual([]);

    // 正对照：证明本规则**真的会命中**（否则它可能是恒真的）—— 两种引号形态各一份。
    const sampleQuoted =
      '.x { background-image: $ftl-art-coin; }\n.y { background-image: url("/static/ui/coin.png"); }';
    expect(usesSlot(sampleQuoted) && BYPASS.test(sampleQuoted), '带引号的正对照必须命中').toBe(true);
    const sampleUnquoted =
      '.x { background-image: $ftl-art-coin; }\n.y { background-image: url(/static/ui/coin.png); }';
    expect(
      usesSlot(sampleUnquoted) && BYPASS.test(sampleUnquoted),
      '无引号 url(...) 的正对照也必须命中（初稿的要求带引号的写法会漏掉它）',
    ).toBe(true);
  });

  it('正对照：九个槽**都真的被模板/样式引用**（防止「加了令牌却没人用」）', () => {
    /**
     * 已退役槽（2026-10-11 第七轮用户裁决）：HUD 去掉整条胶囊底板 ⇒
     * `ftl-art-bottom-bar` 的消费点（TableHud 的 border-image）被删，但**槽位保留登记**
     * （素材仍在 static/ui/，EXPECTED_SLOT_VALUES 仍钉其值；将来胶囊底栏复活时重新接通即可）。
     * 新增退役槽必须在 uni.scss 该槽注释里写明裁决原因，否则不许进这个表。
     */
    const RETIRED: ReadonlyArray<(typeof SLOTS)[number]> = ['ftl-art-bottom-bar'];
    const active = SLOTS.filter((s) => !RETIRED.includes(s));
    const all = sources.map((f) => stripComments(f.content)).join('\n');
    const unused = active.filter((s) => !all.includes(`$${s}`) || all.indexOf(`$${s}`) === all.lastIndexOf(`$${s}`));
    // 每个在用槽应当出现 ≥2 次：uni.scss 的定义 + 至少一处使用
    expect(unused, `这些槽只在 uni.scss 里定义、没有任何组件使用：${unused.join('、')}`).toEqual([]);
    // 防退役表腐烂：退役槽必须确实零消费（谁偷偷重新接通了，就把它从 RETIRED 拿掉）。
    const revived = RETIRED.filter(
      (s) => all.includes(`$${s}`) && all.indexOf(`$${s}`) !== all.lastIndexOf(`$${s}`),
    );
    expect(revived, `这些槽已重新有人使用，请从退役表移除：${revived.join('、')}`).toEqual([]);
  });
});

/**
 * 倒计时钟容器的**标准铺贴**（A′ 档：合形素材已接通，铺贴形态不变）。
 *
 * **判据形态的变迁（第四形态）**：
 *  · 第二形态（Task B6）钉的是**变体 ④**（`auto 100%` + `left center` + 亮字描边）——
 *    那是为**宽胶囊**素材（`jishianniudi.png` 327×115）量身定做的适配；
 *  · 第三形态：用户 2026-09-29 裁决宽胶囊与圆钟**形状不匹配** ⇒ 变体 ④ 整条退回、
 *    槽值退回 `none`，容器回到标准铺贴；
 *  · 第四形态（A′ 档，2026-06）：合形素材 `countdown.png`（**200×200** 金色闹钟）到位 ⇒
 *    槽值翻成 `url(...)`，但容器仍是**标准铺贴 `100% 100%`**（源图正方、容器近正方，
 *    不需要 auto/position）。本闸继续守住：两处容器必须 `100% 100%`、仍**不得**出现
 *    变体 ④ 的痕迹（`auto 100%` / `background-position`）—— 拦的是「照着 B6 旧注释
 *    把宽胶囊适配抄回来」。素材面的拦截在 `EXPECTED_SLOT_VALUES`，容器面的拦截在这里。
 *
 * ⚠️ 本闸钉的是**声明**，不是渲染 —— 观感（铃铛不被裁、秒数可读）只能人眼 + 真浏览器走查（spec §1.1-8）。
 */

/**
 * 两处倒计时钟容器（2026-10-11 第三轮起：对手钟在 `TurnTimer.vue`、
 * 我的中央钟在 `table.vue`；同日起两者统一 88×92 同档）。
 */
const CLOCK_CONTAINERS = [
  { path: 'src/components/TurnTimer.vue', cls: 'turn-timer' },
  { path: 'src/components/table/ddz/DdzBoard.vue', cls: 'table__clock' },
] as const;

/**
 * 取 `src` 里**选择器含完整类名** `.{cls}` 的全部一层规则块体（大括号内文本）。
 * ⚠️ 完整类名 = `(?![\w-])`：`.turn-timer` 不得吃掉 `.turn-timer__value` /
 * `.turn-timer__value--urgent` 的规则体（它们不含背景声明，混进来会让「some」检查失真）。
 */
function ruleBodies(src: string, cls: string): string[] {
  return [...src.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => new RegExp(`\\.${cls}(?![\\w-])`).test(m[1]!))
    .map((m) => m[2]!);
}

describe('倒计时钟容器：标准铺贴（A′ 档合形素材已接通，铺贴形态不变）', () => {
  it('两处容器都是 `100% 100%`，且没有变体 ④ 的痕迹（`auto 100%` / `background-position`）', () => {
    for (const { path, cls } of CLOCK_CONTAINERS) {
      const src = stripComments(sources.find((f) => f.path === path)!.content);
      const bodies = ruleBodies(src, cls);
      // 射程自证：断言锚在「真的有这个规则块」上（块缺失 ⇒ 下面 some() 为 false ⇒ 红）。
      expect(bodies.length, `${path} 里必须有 .${cls} 的规则块`).toBeGreaterThan(0);
      expect(
        bodies.some((b) => /background-size\s*:\s*100%\s+100%\s*;/.test(b)),
        `${path} 的 .${cls}：A′ 档闹钟是正方素材，标准铺贴 background-size: 100% 100%`,
      ).toBe(true);
      expect(
        bodies.filter((b) => /background-size\s*:\s*auto\s+100%\s*;/.test(b)),
        `${path} 的 .${cls}：变体 ④（auto 100%）是给宽胶囊素材的形状适配 —— 已随裁决退回，不得回来`,
      ).toEqual([]);
      expect(
        bodies.filter((b) => /background-position\s*:/.test(b)),
        `${path} 的 .${cls}：标准铺贴不需要 background-position（变体 ④ 的 left center 已退回）`,
      ).toEqual([]);
    }
  });
});
