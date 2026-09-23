import JSZip from 'jszip';
import { UploadedImage } from '../types';

/** URL for one image, plus whether the caller owns it (created here → revoke). */
export interface ResolvedResultUrl {
  url: string;
  release: boolean;
}

/**
 * Download `images` as one ZIP (a PNG per image), resolving each entry through
 * `resolve`.
 *
 * Callers pass the same rendering they show in the "已完成" tab, so the archive
 * always matches the canvas — an image with nothing painted resolves to its
 * untouched file, which is exactly how the result tab renders it. That is why
 * both ZIP paths (gallery export and 全部 scope download) share this function
 * and differ only in the list of images they hand over.
 *
 * Images go in sequentially: a gallery can hold dozens of large pictures and
 * doing the canvas work in parallel is what used to OOM the tab.
 */
export const downloadImagesAsZip = async (
  images: UploadedImage[],
  resolve: (image: UploadedImage) => Promise<ResolvedResultUrl>,
  zipName = 'results.zip'
): Promise<void> => {
  const zip = new JSZip();
  const folder = zip.folder('images');

  for (const img of images) {
    const fileName = img.file.name.replace(/\.[^.]+$/, '') + '.png';
    let ownedUrl: string | null = null;
    try {
      const resolved = await resolve(img);
      if (resolved.release) ownedUrl = resolved.url;
      const blob = await (await fetch(resolved.url)).blob();
      folder?.file(fileName, blob);
    } catch (e) {
      console.error('Failed to add image to zip:', img.file.name, e);
      // Keep the entry in the archive: fall back to the untouched preview.
      try {
        const blob = await (await fetch(img.previewUrl)).blob();
        folder?.file(fileName, blob);
      } catch { /* unreadable image — skip the entry */ }
    } finally {
      // Only URLs created by this call; the stitch cache owns its own.
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    }
  }

  const content = await zip.generateAsync({ type: 'blob', streamFiles: true });
  const objectUrl = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = zipName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
};
