import { useCallback, useState, type DragEvent, type ReactNode } from 'react';

interface ImageUploadDropZoneProps {
  children: ReactNode;
  className?: string;
  activeClassName?: string;
  onClick?: () => void;
  onFiles: (files: File[]) => void;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || file.name.toLowerCase().endsWith('.svg');
}

function resolveImageFiles(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer.files ?? []).filter(isImageFile);
}

function stopDropEvent(event: DragEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

export function ImageUploadDropZone({
  children,
  className = '',
  activeClassName = '',
  onClick,
  onFiles,
}: ImageUploadDropZoneProps) {
  const [dragDepth, setDragDepth] = useState(0);
  const isDragActive = dragDepth > 0;

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    stopDropEvent(event);
    setDragDepth((depth) => depth + 1);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    stopDropEvent(event);
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    stopDropEvent(event);
    setDragDepth((depth) => Math.max(0, depth - 1));
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      stopDropEvent(event);
      setDragDepth(0);
      const files = resolveImageFiles(event);
      if (files.length > 0) {
        onFiles(files);
      }
    },
    [onFiles]
  );

  return (
    <div
      className={`${className} ${isDragActive ? activeClassName : ''}`}
      onClick={onClick}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}
