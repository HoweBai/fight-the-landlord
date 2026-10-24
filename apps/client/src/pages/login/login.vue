﻿<script setup lang="ts">
/**
 * 登录页。认证走 REST（§5.1），成功后由 App 层建立 socket 连接。
 *
 * ⚠️ 登录成功必须用**新**令牌重建 WS 会话：应用启动时的连接可能还是匿名/开发身份，
 * 而握手只在建连时读一次 `clientConfig.token`。用 `restartGameSession()` 重建，
 * **不要**从 `main.ts` 导出工厂（会形成入口模块循环依赖）。
 *
 * 开发期提供「以开发身份进入」：直连协调者的 mock 时不需要 token。
 *
 * 页面栈（Task 3）：本页是 `pages.json` 的**首个页面**（冷启动入口）。本地有令牌时
 * `hydrate()` 已经把 `auth.page` 置成 `'lobby'` ⇒ 走 `usePageAlignment('login')` 对齐。
 *
 * ➊ 重排（本片 Task 1）/ 2026-10-10 去重（用户裁决）：
 *  - `.login__seg` 分段控件是**唯一**的「登录 / 注册」形态切换（选中态 `.login__seg-item--active`）；
 *  - `.login__actions` 只有**一颗**主按钮：文案随形态变「登录 / 注册」（提交中「登录中… / 注册中…」）。
 *    旧版那颗「另一个动作直接提交」的次按钮已删 —— 与分段控件语义重复，且会跳过
 *    注册态的两次密码校验；走注册路径 = 先点分段「注册」、再点主按钮（探针同步迁移）；
 *  - 注册态多一个确认密码字段（纯 UI 字段，从不发给服务端）；
 *  - 密码可见性只改 input 的 `type`（默认必须是 `password`）；
 *  - 提交中主按钮文案变「登录中… / 注册中…」并禁用（M06 的 UI 面）。
 *
 * ⚠️ 校验只做**非空**与「注册态两次密码一致」（R650）：手机号/密码的格式权威判定在服务端，
 * 前端不重复（§12 精神：不造第二个真源）。
 */
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { restartGameSession } from '../../composables/useGameSession';
import { usePageAlignment } from '../../composables/usePageAlignment';
/** 片①：横屏画布（R710）。 */
import LandscapeStage from '../../components/LandscapeStage.vue';
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';

const auth = useAuthStore();
usePageAlignment('login');

/**
 * 提示收敛（Task 5）：本页错误不再占文档流，统一走 `NoticeStack` 浮层（挂在
 * `LandscapeStage` 的 `overlay` 槽）。
 *
 * 两个状态位：
 *  - `field`：纯前端字段校验（error 8s 自消）；
 *  - `auth`：`auth.error` 的投影，**sticky**（`durationMs: 0`）到下一次提交 ——
 *    登录/注册开始时 store 会先清 `error`，watch 收到空串 ⇒ `setNotice` 自动 dismiss。
 *    `immediate: true`：BACK_TO_LOBBY 踢出 / 冷启动失效留下的原因在挂载时就呈现。
 */
const notices = usePageNotices();
const { items: noticeItems } = notices;

watch(
  () => auth.error,
  (text) => {
    notices.setNotice('auth', text, { level: 'error', durationMs: 0 });
  },
  { immediate: true },
);

function setFieldError(text: string): void {
  notices.setNotice('field', text, { level: 'error' });
}

type AuthMode = 'login' | 'register';

const mode = ref<AuthMode>('login');
const phone = ref('');
const password = ref('');
/** 确认密码：**仅注册态**渲染，也从不出现在请求载荷里。 */
const confirm = ref('');
/** 昵称（昵称片）：**仅注册态**渲染，必填、trim 后 1–20 字符。 */
const nickname = ref('');
const showPassword = ref(false);
const busy = ref(false);

const isRegister = computed(() => mode.value === 'register');
/** 主按钮文案：正在提交时进入加载态（禁用态/加载态文案只在 `busy` 期间出现）。 */
const primaryLabel = computed(() => {
  if (busy.value) return isRegister.value ? '注册中…' : '登录中…';
  return isRegister.value ? '注册' : '登录';
});

/**
 * 开发态幽灵入口的门（仅 dev/mock 调试用，生产构建必须消失）。
 *
 * ⚠️ **必须在 `<script>` 里读、模板只引用变量**：Vue 模板表达式解析器不是 module 模式，
 * 在模板里直接写 `import.meta.env.DEV` 会编译失败（`import.meta may appear only with
 * sourceType: "module"`，实测收集期炸一片用例）。这里仍是**直接属性访问**
 *（config.ts 纪律：不得写 `typeof import.meta` 守卫），构建期照样被替换成字面量。
 * vitest 下 DEV=true ⇒ 幽灵按钮在测试里照常存在。
 */
const isDev = import.meta.env.DEV;

function setMode(next: AuthMode) {
  mode.value = next;
  // 切形态后旧字段错误已不对应（「两次密码不一致」在登录态没有意义）。
  notices.dismiss('field');
}

/**
 * 字段级校验（R650）：只有这三条。
 *
 * 手机号/密码的**格式**判定属于服务端（前端不造第二个真源）⇒ 这里只看「填了没有」
 * 与「注册态两次输入是否一致」。
 */
function validate(): string {
  if (!phone.value.trim()) return '请输入手机号';
  if (!password.value) return '请输入密码';
  if (isRegister.value && confirm.value !== password.value) return '两次输入的密码不一致';
  // 昵称（昵称片）：校验顺序放在密码之后，保持既有「两次密码不一致」优先的体验。
  if (isRegister.value && !nickname.value.trim()) return '请输入昵称';
  if (isRegister.value && nickname.value.trim().length > 20) return '昵称最多 20 个字符';
  return '';
}

/**
 * 提交**当前形态**的动作。
 *
 * ⚠️ **不再是 `<form @submit.prevent>`**（Task 2 的 A 项按派工单把 `form` 改成 `view`，
 * 见标签映射表）。语义不变：`.login__actions` 里那颗主按钮的 `@click` 按当前分段形态
 * 走「登录」或「注册」（形态由顶部 `.login__seg` 唯一决定）。
 *
 * 注：`label` → `view` 后失去了「点文字聚焦输入框」的原生关联。uni-app 里
 * 内层原生 input 由运行时生成，恢复它要依赖 `uni.createSelectorQuery().node()`，
 * 在 jsdom 测试环境里不可用 ⇒ 不为一个便利行为引入跨端不确定代码。
 */
async function submit() {
  if (busy.value) return;
  const invalid = validate();
  if (invalid) {
    setFieldError(invalid);
    return;
  }
  notices.dismiss('field');
  busy.value = true;
  try {
    const signed = isRegister.value
      ? await auth.signUp(phone.value.trim(), password.value, nickname.value.trim())
      : await auth.signIn(phone.value.trim(), password.value);
    if (signed) restartGameSession();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <LandscapeStage>
    <view class="login">
      <!--
        标签映射（派工单 A）：`section/header/div/ul/li → view`、`span/p/h1/h2 → text`；
        `button`/`input` 保持 uni-app core 组件。class 名一个不改（探针与测试的锚点）。
        ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
        `classes()` 静默返回 `[]`。
      -->
      <!--
        片① 样板（2026-09-27）：**单列居中** —— 品牌在最上（logo 居中），
        表单由一层半透明面板托住，开发入口移出面板。
        ⚠️ 结构变了、**锚点没全变**：`.login__field input` 的**顺序**、
        `.login__actions` 主按钮、`.login__seg-item` 全部原样（2026-10-10 去重：次按钮已删）。
      -->
      <view class="login__brand">
        <image class="login__logo" src="/static/ui/logo.png" mode="aspectFit" />
        <!-- 2026-10-19 用户裁决：品牌位**只保留图标** —— logo 图片里已含「欢乐斗地主」字样，
             下面再挂一行「优比棋牌」是重复信息（应用名仍以 manifest `name` 为准）。 -->
      </view>

      <view class="login__panel">
        <view class="login__seg">
          <button
            type="button"
            class="login__seg-item"
            :class="{ 'login__seg-item--active': !isRegister }"
            @click="setMode('login')"
          >
            登录
          </button>
          <button
            type="button"
            class="login__seg-item"
            :class="{ 'login__seg-item--active': isRegister }"
            @click="setMode('register')"
          >
            注册
          </button>
        </view>

        <view class="login__form">
          <view class="login__field login__field--phone">
            <text>手机号</text>
            <!-- 2026-10-18 真机：**不设** inputmode="tel"（弹全键盘）。横屏 + 讯飞输入法下
                 数字键盘会变成悬浮小键盘、正好盖住居中的登录卡片；全键盘无此问题。 -->
            <input v-model="phone" type="text" autocomplete="username" placeholder="13800000000" />
          </view>
          <view class="login__field login__field--password">
            <text>密码</text>
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="••••••"
            />
            <button
              type="button"
              class="login__toggle-visibility"
              @click="showPassword = !showPassword"
            >
              {{ showPassword ? '隐藏' : '显示' }}
            </button>
          </view>
          <view v-if="isRegister" class="login__field login__field--confirm">
            <text>确认密码</text>
            <input v-model="confirm" type="password" autocomplete="new-password" placeholder="再次输入密码" />
          </view>
          <view v-if="isRegister" class="login__field login__field--nickname">
            <text>昵称</text>
            <input v-model="nickname" type="text" maxlength="20" placeholder="1–20 个字符" />
          </view>

          <view class="login__actions">
            <button type="button" class="btn btn--primary" :disabled="busy" @click="submit">
              {{ primaryLabel }}
            </button>
          </view>
        </view>
      </view>

      <!-- 开发入口：移出面板（不再占主流程的高度）—— 无 DOM 锚点，位置自由（规格 §5.2）。
           ⚠️ **生产构建必须消失**（仅 dev/mock 调试用）：门在 script 里读 `isDev`
           （模板表达式里不能直接出现 import.meta，见 isDev 注释）。vitest 下 DEV=true ⇒
           幽灵按钮的结构断言自动保持成立。 -->
      <button v-if="isDev" type="button" class="btn btn--ghost" @click="auth.enterAsDevUser()">
        以开发身份进入（连 mock 用）
      </button>
    </view>

    <!-- 提示浮层（Task 5）：字段校验 / 登录失败/失效原因都在这里，不占表单文档流。 -->
    <template #overlay>
      <NoticeStack :items="noticeItems" surface="login" @dismiss="notices.dismiss" />
    </template>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/* 横屏 750 高画布：注册态（3 输入框）整列必须装得下，输入/提交取紧凑档 control-h-sm。 */
/**
 * 片① 样板（2026-09-27）：**单列居中是 D15 的用户决定** —— 品牌在上，表单由一层
 * **半透明深蓝面板**托住（视觉「乙」：去掉不透明白卡，内容直接浮在底纹上）。
 *
 * ⚠️ **R716 那条实测约束仍然成立，本片没有推翻它**：单列纵排在**基准缩放 S=1** 下高
 *    **1222** 设计 px，而画布只有 **750** ⇒ 本片的应对是**压缩 + 整列滚动兜底**
 *    （规格 §3 / §3.1），装不装得下由真浏览器实测决定（规格 §6）。
 *    走查修复（注册态实测超高）：页面/面板内边距收到 space-5、表单间隙收到 space-4、
 *    三个输入框与两颗提交按钮取 `control-h-sm`(56) ⇒ 注册列 S=1 压到约 **700px** ≤ 750；
 *    内容真的超高时仍由整列滚动兜底（Task 5 起错误提示是浮层，不再参与这段高度计算）。
 *    ⚠️ Task 2b 订正：滚的是**整列**（`.login`）、**不是面板** —— 面板内滚动会把
 *    提交按钮裁在看不见的地方（Task 2 实测到的缺陷）。
 *
 * ⚠️ **居中由 `LandscapeStage` 的 `.canvas`（flex center）负责** —— 这里不写 `margin: auto`。
 * ⚠️ 面板的**半透明深蓝底是为可读性**：画布底纹是一张风景插画，表单直接浮在上面读不清。
 * ⚠️ 本 Task **不改文案、不加新元素**（品牌视觉重做属片③）。
 *
 * ⚠️ 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义** ——
 *    令牌是全局的，改一个值会同时改掉其他三页）。
 * ⚠️ 这组取值**已定稿**（2026-09-27 样板拍板，总规格 §5.2.1「视觉语言定稿」）——
 *    其余三页照抄这一组，不要再各自发挥。
 */
.login {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-4;
  width: 100%;
  height: 100%;
  padding: $ftl-space-5;
  /* ⚠️ 整列可滚（内容真的超高时，用户能滚到按钮）——
     而不是让**面板**内部滚（那会把自己的按钮裁在看不见的地方）。 */
  overflow-y: auto;
}
.login__brand {
  display: flex;
  flex: 0 0 auto; /* 不被压缩 */
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-3;
}
/**
 * 半透明深蓝面板：托住表单（可读性）。
 * ⚠️ **不设** `max-height: 100%` / `overflow-y: auto`（Task 2 曾设、Task 2b 删）——
 *    它们是「面板自己滚」的来源，而**面板不该滚**（那会把提交按钮裁在看不见的地方）；
 *    内容真的超高时由**整列**（`.login`）滚动兜底。
 */
.login__panel {
  box-sizing: border-box;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: $ftl-space-3;
  width: 480px;
  padding: $ftl-space-5;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
/**
 * 品牌 logo（U3）。源图 237×147（比例 1.612）⇒ 盒宽 192、高 **96**（Task 2b 压缩，原 120）；
 * `aspectFit` 按高适配（不裁切、不变形，左右留空）。
 */
.login__logo {
  width: 192px;
  height: 96px;
}
.login__seg {
  box-sizing: border-box;
  display: flex;
  gap: $ftl-space-2;
  padding: $ftl-space-2;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-night-deep, 0.55);
}
.login__seg-item {
  box-sizing: border-box;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: $ftl-control-h-sm;
  margin: 0;
  padding: 0 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-sm;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-md;
  line-height: 1.2;
  cursor: pointer;
}
.login__seg-item--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.18);
  color: $ftl-color-gold-light;
  font-weight: 700;
}
.login__form {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
}
/** 面板内文字改浅色（原来在白色卡片上是深灰，压在深蓝面板上会看不清）。 */
.login__field {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  font-size: $ftl-font-sm;
  color: rgba($ftl-color-on-primary, 0.75);
}
.login__field input {
  box-sizing: border-box;
  width: 100%;
  /* 紧凑档（走查修复）：注册态 3 个输入框要压进 750 高画布；字号保持 lg，56 高仍可读可点。 */
  height: $ftl-control-h-sm;
  padding: 0 $ftl-space-7;
  border: $ftl-hairline solid $ftl-color-border-control;
  border-radius: $ftl-radius-md;
  background: $ftl-color-surface;
  color: $ftl-color-text;
  font-size: $ftl-font-lg;
}
/**
 * 密码字段（片③ Task 5 / R744）：「显示/隐藏」**与密码框成组** —— 同一行、`align-items: center`、
 * 间距用令牌（走 grid，不是加 wrapper）。
 *
 * ⚠️ **为什么用 grid 而不是插一层 `view`**：本页的结构被探针钉死 —— 真浏览器探针按
 * `.login__field input` 的**文档顺序**取手机号/密码两个输入框（`inputs[0]`/`inputs[1]`）。
 * grid 是**纯样式**的同排方案 ⇒ 模板一个字节不用动。`text` 标签选择器会被 uni-app
 * 编译成 `uni-text`（与既有 `.login__field input` → `uni-input` 同一机制，构建产物里可见），
 * 标签占满整行 ⇒ 与其它字段「标签在上、控件在下」的节奏保持一致。
 *
 * 实测（改前 · 两列时代，画布 px）：输入框 410 宽，`显示` 按钮 52×36 孤零零挂在输入框**下面**一行
 * （左贴面板边）—— 这正是 spec §5 缺陷 2「文字飘着」。
 */
.login__field--password {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  row-gap: $ftl-space-2;
  column-gap: $ftl-space-4;
}
.login__field--password text {
  grid-column: span 2;
}
/* `.login__toggle-visibility`：原来在白色卡片上是 text-muted（深灰），
   压在深蓝面板上读不清 ⇒ 改浅色。注意它**不是** `.btn`，是字段内的次级动作。
   `align-self: center`：它排到密码框右侧后，跨轴对齐由 flex-start 改 center。 */
.login__toggle-visibility {
  align-self: center;
  margin: 0;
  padding: 0;
  border: 0px;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
  cursor: pointer;
}
/* ⚠️ Task 5 起错误提示走 `NoticeStack` 浮层（`.stage__overlay`），表单里不再有
   内联错误行 —— 原先的 `.login__field-error` / `.login__error` 规则已删。 */
/**
 * 动作区（2026-10-10 去重）：**只剩一颗主按钮**，占满整行。
 *
 * 「登录 / 注册」形态切换唯一入口是顶部 `.login__seg`；旧版那颗与分段控件语义重复的
 * 次按钮（还会跳过注册的两次密码校验直接发请求）已删，探针走注册路径改为
 * 「先点分段『注册』→ 再点这颗主按钮」。
 *
 * ⚠️ **`margin-top: $ftl-space-6`（16px）**：表单容器 `.login__form` 的 `gap` 只有 8px，
 * 密码框与按钮贴得太近（走查反馈）；提交按钮是表单终点，与最后一个字段拉开一档。
 *
 * ⚠️ `margin: 0`（在 `.login__actions .btn` 上）不是装饰：uni-app 的 `uni-button`
 * 基样式带 `margin-left/right: auto`，不压掉它按钮不会按 flex 宽度排。
 */
.login__actions {
  display: flex;
  flex-direction: row;
  gap: $ftl-space-4;
  margin-top: $ftl-space-6;
}
.login__actions .btn {
  flex: 1 1 0;
  /* 紧凑档（与分段控件同高）：为注册态的第三个输入框让出纵向空间。 */
  min-height: $ftl-control-h-sm;
  margin: 0;
}
.btn {
  @include ftl-btn;
  /* 2026-10 UI 重设计：次按钮（默认态）改成冷灰弱化风格 */
  border-color: rgba(160, 170, 190, 0.5);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(120, 130, 150, 0.35), rgba(80, 90, 110, 0.5));
  color: rgba($ftl-color-on-primary, 0.7);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 2px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  transition: transform 0.1s, box-shadow 0.1s, border-color 0.15s;
  background-image: none;
  &:hover {
    border-color: rgba(180, 190, 210, 0.7);
    color: rgba($ftl-color-on-primary, 0.85);
  }
  &:active {
    transform: translateY(2px);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.3);
  }
}
/** 主按钮：金色 + 深金描边（参考图的按钮语言）。
 *  2026-10 UI 重设计：新增拟物化立体阴影。 */
.btn--primary {
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
  border-radius: $ftl-radius-md;
  box-shadow:
    0 6px 0 $ftl-color-gold-deep,
    0 8px 20px rgb(255 152 0 / 0.45),
    inset 0 2px 0 rgb(255 255 255 / 0.6),
    inset 0 -2px 0 rgb(0 0 0 / 0.1);
  transition: transform 0.1s, box-shadow 0.1s;
  background-image: none;
  &:hover {
    transform: translateY(-2px);
    box-shadow:
      0 8px 0 $ftl-color-gold-deep,
      0 12px 28px rgb(255 152 0 / 0.55),
      inset 0 2px 0 rgb(255 255 255 / 0.6);
  }
  &:active {
    transform: translateY(4px);
    box-shadow:
      0 2px 0 $ftl-color-gold-deep,
      0 4px 10px rgb(255 152 0 / 0.3),
      inset 0 3px 8px rgb(0 0 0 / 0.2);
  }
}
/* `.btn--ghost` 在面板外、直接浮在渐变上 ⇒ 改浅色 + 半透明白描边；
   并**必须覆盖 `ftl-btn` 的白底与贴图**（白底贴图会渲染成一圈白板子，截图可见）。
   `width: auto` + `align-self: flex-end` 是 Task 2b 实测的结果：`width: 100%` 会让它变成
   一条横跨 1302px（实测）的虚线大胶囊。 */
.login .btn--ghost {
  flex: 0 0 auto;
  width: auto;
  margin: 0;
  align-self: flex-end;
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  border-style: dashed;
  border-color: rgba($ftl-color-on-primary, 0.45);
  background: transparent;
  background-image: none;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
}
.btn[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
