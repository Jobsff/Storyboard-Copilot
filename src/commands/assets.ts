import { invoke, isTauri } from '@tauri-apps/api/core';

export interface PersistSpinePackageResult {
  packageId: string;
  files: Record<string, string>;
}

export interface SpineFrameAnimationPayload {
  name?: string;
  frameSources: string[];
  fps?: number;
  loopAnimation?: boolean;
}

export interface ExportSequenceFramesAsSpinePayload {
  packageName?: string;
  animations: SpineFrameAnimationPayload[];
  trimTransparent?: boolean;
  alphaThreshold?: number;
  maxTextureSize?: number;
  targetDir?: string;
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

export async function exportSequenceFramesAsSpine(
  payload: ExportSequenceFramesAsSpinePayload
): Promise<PersistSpinePackageResult> {
  if (!isTauri()) {
    throw new Error('Spine export requires Tauri runtime');
  }

  const result = await invoke<{ package_id: string; files: Record<string, string> }>(
    'export_sequence_frames_as_spine',
    { payload }
  );

  return {
    packageId: result.package_id,
    files: result.files,
  };
}
