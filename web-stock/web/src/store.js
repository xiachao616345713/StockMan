/**
 * 跨视图共享状态（模块级单例 ref）。
 *
 * 本项目规模小（7 个视图、2 个共享状态），故不引入 Pinia，
 * 用组合式模块代替（决策记录见 docs/design.md）。
 */

import { ref } from 'vue';

/** 当前激活的标签页：chat | overview | stock | sector | limitup | screener | dragontiger | hotrank | settings（默认 AI 助手聊天框；settings 由齿轮按钮触发，不在导航标签内） */
export const activeTab = ref('chat');

/** 当前选中的股票代码（个股页使用） */
export const selectedCode = ref('');

/**
 * 从任意视图跳转到个股页并加载指定股票
 *
 * @param {string} code 6 位股票代码
 */
export function openStock(code) {
    selectedCode.value = code;
    activeTab.value = 'stock';
}
