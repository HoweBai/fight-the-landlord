/**
 * vitest 全局 setup。
 *
 * ## 为什么需要它：把 uni-app 的 **easycom** 在测试环境里补上
 *
 * 生产端 `wd-*` 组件是 `src/pages.json` 的 easycom 规则在**编译期**解析的：
 * `"^wd-(.*)": "wot-design-uni/components/wd-$1/wd-$1.vue"`（派工单 D 逐字给定）。
 * 那条规则由 uni 的编译器生效，**vitest 跑的是 `@vitejs/plugin-vue`**，没有 easycom ⇒
 * `<wd-cell>` 会被当成「未解析组件」，渲染成一个**吞掉全部子节点**的裸自定义元素：
 * 断言「房间列表里能看到 ROOM01」这类用例会静默失配（不是读取失败，而是选择器落在空气上）。
 *
 * ## 这里注册的是什么
 *
 * **结构性替身**，不是组件库的复刻：
 *  - 把自定义 class/属性**透传到根元素**（`wd-cell` / `wd-card` / `wd-tag` … 的真实实现里，
 *    自定义 class 就是落在根元素上 —— `attrs` 的默认继承正是这个行为）；
 *  - 渲染默认/具名插槽（`wd-card` 的默认插槽、`wd-cell` 的 `title`+默认插槽）；
 *  - 不复制任何视觉/交互逻辑。
 *
 * 换句话说：**单测只验证「我们把什么放进了组件」**（class 锚点、插槽内容、
 * 是否传了 `clickable` 这类接线）；「`wd-cell` 究竟长什么样、能不能点」由真浏览器探针
 * （`scripts/browser-e2e.mjs`，协调者独占跑）在 H5 上验证。
 *
 * ⚠️ 这里**不得**用 `vi.mock` 去改 `src/**` 的行为；它只补「编译期解析」这一块。
 */
import { defineComponent, h, type VNode } from 'vue';
import { config } from '@vue/test-utils';

/** 把具名插槽渲染成 `<slot>` 已经做的事：这里显式摊平，保证顺序 = 模板顺序。 */
function renderSlot(slot: unknown): VNode[] {
  if (typeof slot !== 'function') return [];
  const rendered = slot();
  return Array.isArray(rendered) ? rendered : [rendered as VNode];
}

/**
 * `wd-*` 的结构替身：根元素固定为 `view`（uni-app 的自定义元素），
 * 属性/class 由 `inheritAttrs` 自动落到根上，插槽全部渲染出来。
 */
const WdStub = defineComponent({
  name: 'WdStub',
  inheritAttrs: true,
  /**
   * ⚠️ **只声明这一个 prop**（spec §4 / R810）：`wd-loadmore` 的 `finished` 分支把
   * 「加载完毕」文案当作**普通文本**渲染（`<wd-divider>{{ finishedText || … }}</wd-divider>`），
   * 而**没有**默认插槽 ⇒ 生产里靠 `finished-text` 传文案。
   *
   * 替身若只渲染插槽，`finished-text` 写法在单测里就**看不见文案**（`auth-ui-wiring`
   * 的空态断言会红）。声明它、并渲染成文本，是让替身**按真组件的契约**表现 ——
   * 这正是替身的职责，**不是**为了让某条断言变绿。
   */
  props: { finishedText: { type: String, default: '' } },
  setup(props, { slots, attrs }) {
    return () => {
      const children: VNode[] = [
        ...renderSlot(slots.title),
        ...renderSlot(slots.default),
        ...renderSlot(slots.footer),
        ...renderSlot(slots.label),
        ...renderSlot(slots.value),
      ];
      if (props.finishedText) children.push(h('text', props.finishedText));
      return h('view', attrs, children);
    };
  },
});

/**
 * easycom 规则 `^wd-(.*)` 覆盖到的组件名。**逐个列出**（而不是用通配）
 * 是为了让「测试里冒充了解析」这件事有据可查：新增 `wd-*` 用法时，这个清单必须同步。
 */
const WD_COMPONENTS = [
  'wd-card',
  'wd-cell',
  'wd-cell-group',
  'wd-divider',
  'wd-loadmore',
  'wd-tag',
] as const;

config.global.components = {
  ...(config.global.components ?? {}),
  ...Object.fromEntries(WD_COMPONENTS.map((name) => [name, WdStub])),
};
