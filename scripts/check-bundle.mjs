// 构建产物测试框架泄漏检查（v0.3.2 二次黑屏事故的构建级防泄锁）。
// 事故：模型扫描 glob 把 image 目录下测试文件打进生产包，
// 其 vitest import 在浏览器启动期抛错导致 React 未挂载（黑屏）。
// vitest 环境里该 import 合法，所以单测与启动冒烟全绿；vite 构建也不执行代码。
// 本脚本在 vite build 之后扫描 dist 产物，出现任何测试框架或测试文件痕迹即失败，
// 把这类问题拦截在构建期而不是用户桌面上。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distAssets = join(process.cwd(), 'dist', 'assets');
const FORBIDDEN_MARKERS = [
  /vitest/i,
  /__vitest/,
  '__tests__/',
  'failed to access its internal state',
];

let failed = false;
for (const file of readdirSync(distAssets)) {
  if (!/\.(js|mjs)$/.test(file)) continue;
  const content = readFileSync(join(distAssets, file), 'utf8');
  for (const marker of FORBIDDEN_MARKERS) {
    const pattern = marker instanceof RegExp ? marker : new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (pattern.test(content)) {
      console.error(`[check-bundle] ✗ ${file} 含测试框架痕迹: ${marker}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('[check-bundle] 测试代码泄漏进生产包——检查 import.meta.glob 范围是否覆盖了 __tests__ 目录');
  process.exit(1);
}
console.log('[check-bundle] ✓ 产物干净：无测试框架/测试文件痕迹');
