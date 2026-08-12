<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import GlobalFeedback from './components/GlobalFeedback.vue'
import Manage from './Manage/index.vue'
import CodeTranslate from './views/CodeTranslate.vue'
import ScreenOcr from './views/ScreenOcr.vue'
import LatexScreen from './views/LatexScreen.vue'

/**
 * 应用根：按 onPluginEnter 的 action.code 在三个 feature 间分流。
 *   - code === 'screen-ocr'：渲染全屏截图识别页（独立 feature，进入即自动截屏）
 *   - code === 'code-translate'：渲染全屏代码翻译候选列表（独立 feature）
 *   - 其它（含 manage）：渲染 Manage 容器，由其按 action.type 切 tab
 *
 * 每次进入产生新引用（enterAction）并递增 enterSeq，驱动下游 watch 与 :key 重建子视图。
 * enterSeq 写入子视图 :key：同一 feature 重复进入（如连按两次「截图识别文字」）
 * 也会改变 key → 组件重建 → onMounted 重新推进，子视图无需再自行注册 onPluginEnter。
 *
 * ⚠️ onPluginEnter 为覆盖式 setter（后注册者覆盖先注册者，无 off API）。
 * 故本文件是 onPluginEnter 的唯一注册点；ScreenOcr / LatexScreen 等子视图不可再注册，
 * 否则会覆盖此处回调，导致后续进入任意 feature 时 enterAction 不再更新、路由失效。
 */
const enterAction = ref<any>({})

/** 每次进入递增的序号：用于子视图 :key，保证同 feature 重复进入也重建实例。 */
const enterSeq = ref(0)

/** 是否进入截图识别文字 feature。 */
const isScreenOcr = computed(() => enterAction.value?.code === 'screen-ocr')

/** 是否进入截图识别公式 feature。 */
const isLatexScreen = computed(() => enterAction.value?.code === 'screen-latex')

/** 是否进入代码翻译 feature。 */
const isCodeTranslate = computed(() => enterAction.value?.code === 'code-translate')

/** 透传给 CodeTranslate 的初始文本（over 入口选中的文本）。 */
const codeTranslateText = computed(() => {
  const a = enterAction.value
  return a && a.code === 'code-translate' && typeof a.payload === 'string' ? a.payload : ''
})

onMounted(() => {
  window.ztools.onPluginEnter((action) => {
    console.log(action)
    // 每次进入产生新引用 + 递增序号，驱动下游 watch 与 :key 重建子视图
    enterAction.value = action
    enterSeq.value++
  })
  window.ztools.onPluginOut(() => {
    // 隐藏/退出：保留 enterAction 以便恢复时仍有上下文
  })
})
</script>

<template>
  <!-- 全局反馈组件：ztools-ui 的 Toast / Confirm 需要 -->
  <GlobalFeedback />

  <!-- 截图识别文字 feature：进入即自动截屏→OCR。:key 含 enterSeq，保证每次进入（含
       同 feature 重复唤醒）都重建实例、状态不残留；重建即触发 onMounted→startFlow -->
  <ScreenOcr
    v-if="isScreenOcr"
    :key="'screen-ocr-' + enterSeq"
  />
  <!-- 截图识别公式 feature：进入即自动截屏→LaTeX 识别→结果窗口。 -->
  <LatexScreen
    v-else-if="isLatexScreen"
    :key="'screen-latex-' + enterSeq"
  />
  <!-- 代码翻译 feature：全屏候选列表。:key 含 enterSeq，保证每次进入重建实例、状态不残留 -->
  <CodeTranslate
    v-else-if="isCodeTranslate"
    :key="'code-translate-' + enterSeq"
    :initial-text="codeTranslateText"
  />
  <!-- 管理 feature：设置/识别/翻译 -->
  <Manage v-else :enter-action="enterAction" />
</template>
