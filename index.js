/**
 * dsh-nokia-pinball — host half（服务端入口）
 *
 * 硬约束：main 指向的文件会在服务端 boot profile 时被 import。
 * 顶层不得引用 window / document / localStorage / AudioContext。
 * 全部游戏逻辑跑在浏览器侧 client.js，宿主只是空壳。
 */
export const name = "nokia-pinball";

export function apply() {
  /* 纯客户端 UI 插件：宿主不持有任何状态 */
}

export default { name, apply };
