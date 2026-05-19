import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

export interface SourceImage {
  id: string;
  name: string;
  img: HTMLImageElement;
}

export const ACCEPTED_FORMATS = '.jpg,.jpeg,.png,.gif,.webp,.avif,.ico,.bmp,.svg';

let nextId = 1;
export function createSourceImage(file: File): Promise<SourceImage> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ id: String(nextId++), name: file.name, img });
    img.src = url;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

export async function exportImage(dataUrl: string, defaultName: string): Promise<boolean> {
  const selectedPath = await save({
    defaultPath: defaultName,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (!selectedPath || typeof selectedPath !== 'string') return false;
  await invoke('save_image_source_to_path', { source: dataUrl, targetPath: selectedPath });
  return true;
}

export async function exportImagesToDir(images: { dataUrl: string; fileName: string }[]): Promise<number> {
  const selectedDir = await open({ directory: true, multiple: false });
  if (!selectedDir || typeof selectedDir !== 'string') return 0;
  let count = 0;
  for (const { dataUrl, fileName } of images) {
    const targetPath = `${selectedDir}/${fileName}`;
    await invoke('save_image_source_to_path', { source: dataUrl, targetPath });
    count++;
  }
  return count;
}
