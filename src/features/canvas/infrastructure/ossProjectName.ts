/**
 * OSS 归档目录工程名（批次11）：gateway 提交生成任务时从 projectStore 取当前工程名，
 * 清洗后塞进 extra_params.oss_project，Rust 侧归档时按同规则再清洗一次兜底。
 *
 * 清洗规则（单一真相源，与 Rust oss_store::sanitize_project_name 逐条对齐）：
 * `/` 替换为 `-`、去首尾空白与点号、空则由 Rust 兜底「未分类」。
 */

export const OSS_PROJECT_EXTRA_PARAM_KEY = 'oss_project';

export function sanitizeOssProjectName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/\//g, '-')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  return cleaned;
}

/**
 * 解析归档工程名参数：无工程上下文（如 Toolbox 页）返回 undefined ——
 * 不塞 extra_params，由 Rust 兜底「未分类」。
 */
export function resolveOssProjectParam(
  projectName: string | null | undefined
): string | undefined {
  const cleaned = sanitizeOssProjectName(projectName);
  return cleaned.length > 0 ? cleaned : undefined;
}
