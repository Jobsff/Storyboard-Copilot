import { invoke, isTauri } from '@tauri-apps/api/core';

export interface PersistSpinePackageResult {
  packageId: string;
  files: Record<string, string>;
}

export async function persistSpinePackageFiles(paths: string[]): Promise<PersistSpinePackageResult> {
  if (!isTauri()) {
    throw new Error('Spine asset import requires Tauri runtime');
  }

  const result = await invoke<{ package_id: string; files: Record<string, string> }>(
    'persist_spine_package_files',
    { paths }
  );

  return {
    packageId: result.package_id,
    files: result.files,
  };
}

