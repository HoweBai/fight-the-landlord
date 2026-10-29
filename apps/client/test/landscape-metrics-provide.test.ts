import { describe, expect, it } from 'vitest';
import { defineComponent, h, inject } from 'vue';
import { mount } from '@vue/test-utils';
import LandscapeStage from '../src/components/LandscapeStage.vue';
import {
  CANVAS_METRICS_KEY,
  layoutMetrics,
} from '../src/composables/useLandscapeCanvas';
import { setWindowSize } from './helpers/uni-stub';

const Probe = defineComponent({
  setup() {
    const metrics = inject(CANVAS_METRICS_KEY, null);
    return () =>
      h('div', { class: 'probe' }, metrics ? `${metrics.value.width}x${metrics.value.height}` : 'none');
  },
});

function probeText(w: number, height: number): string {
  setWindowSize(w, height);
  const wrapper = mount(LandscapeStage, {
    slots: { default: () => h(Probe) },
  });
  return wrapper.find('.probe').text();
}

describe('LandscapeStage 画布尺寸 provide', () => {
  it('插槽内容能 inject 到与舞台同一份画布尺寸（16:9）', () => {
    const expected = layoutMetrics(1280, 720);
    expect(probeText(1280, 720)).toBe(`${expected.width}x${expected.height}`);
  });

  it('19.5:9 手机上不是兜底值（宽度 > 1334）', () => {
    const [wText] = probeText(844, 390).split('x');
    expect(Number(wText)).toBeGreaterThan(1334);
  });

  it('4:3 平板上高度 > 750', () => {
    const [, hText] = probeText(1024, 768).split('x');
    expect(Number(hText)).toBeGreaterThan(750);
  });
});
