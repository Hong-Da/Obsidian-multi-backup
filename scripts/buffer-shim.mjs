// 打包时注入：依赖里直接用到的 Buffer 指向打包进来的 buffer 包，移动端也能用（不改全局变量）
export { Buffer } from "buffer";
