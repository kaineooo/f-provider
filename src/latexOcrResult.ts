import { createApp } from 'vue'
import ZToolsUI from 'ztools-ui'
import 'ztools-ui/style'
import { useZtoolsTheme } from 'ztools-ui'
import './main.css'
import LatexOcrResult from './views/LatexOcrResult.vue'

// 公式识别结果展示窗口入口（由 ztools.createBrowserWindow 打开）。
//
// 与 screenOcrResult.ts 同构：该窗口由 createBrowserWindow 创建，**不带 preload**，
// 也没有可靠的 window.ztools API。因此窗口只做展示——
// 主窗口在外层完成「截图 + LaTeX 识别」后，通过 webContents.executeJavaScript
// 把识别结果（imageSrc + latex + isDark）注入到本窗口。
//
// 注入方式：主窗口调用 executeJavaScript('window.__loadLatexOcrResult({...})')。
// 本入口在挂载后挂载 window.__loadLatexOcrResult，并把数据交给组件渲染。

// useZtoolsTheme 在无 window.ztools 时会优雅降级（不报错），主题以注入的 isDark 为准。
useZtoolsTheme()

const app = createApp(LatexOcrResult)
app.use(ZToolsUI)
app.mount('#app')
