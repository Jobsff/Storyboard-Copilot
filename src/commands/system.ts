import { invoke, isTauri } from '@tauri-apps/api/core';

export interface RuntimeSystemInfo {
  osName: string;
  osVersion: string;
  osBuild: string;
  logDir?: string | null;
}

export async function getRuntimeSystemInfo(): Promise<RuntimeSystemInfo | null> {
  if (!isTauri()) {
    return null;
  }

  try {
    return await invoke<RuntimeSystemInfo>('get_runtime_system_info');
  } catch (error) {
    console.warn('failed to get runtime system info from tauri', error);
    return null;
  }
}

export async function logFrontendEvent(
  level: 'info' | 'warn' | 'error',
  message: string,
  payload?: Record<string, unknown>
): Promise<void> {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke('log_frontend_event', {
      level,
      message,
      payload: payload ?? {},
    });
  } catch {
    // Logging must never break the user workflow.
  }
}
