import { decodePng, encodePng, type DecodedImage } from './png';

/**
 * Resampling and compositing helpers used to derive the exact asset densities
 * that Android (`mipmap-*`), the PWA manifest and store listings require from a
 * single high-resolution source image.
 */

/** Bilinear resample with a box pre-filter when minifying (avoids aliasing). */
export function resizeRgba(src: DecodedImage, width: number, height: number): DecodedImage {
  if (src.width === width && src.height === height) return src;
  const out = new Uint8Array(width * height * 4);
  const scaleX = src.width / width;
  const scaleY = src.height / height;
  const boxX = Math.max(1, Math.floor(scaleX));
  const boxY = Math.max(1, Math.floor(scaleY));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const sx0 = Math.min(src.width - 1, Math.floor((x + 0.5) * scaleX - boxX / 2));
      const sy0 = Math.min(src.height - 1, Math.floor((y + 0.5) * scaleY - boxY / 2));
      for (let by = 0; by < boxY; by += 1) {
        for (let bx = 0; bx < boxX; bx += 1) {
          const sx = Math.min(src.width - 1, Math.max(0, sx0 + bx));
          const sy = Math.min(src.height - 1, Math.max(0, sy0 + by));
          const i = (sy * src.width + sx) * 4;
          const alpha = (src.rgba[i + 3] as number) / 255;
          r += (src.rgba[i] as number) * alpha;
          g += (src.rgba[i + 1] as number) * alpha;
          b += (src.rgba[i + 2] as number) * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      const alpha = a / n;
      out[o] = clamp(a > 0 ? r / a : 0);
      out[o + 1] = clamp(a > 0 ? g / a : 0);
      out[o + 2] = clamp(a > 0 ? b / a : 0);
      out[o + 3] = clamp(alpha * 255);
    }
  }
  return { width, height, rgba: out };
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function resizePng(png: Buffer, width: number, height: number): Buffer {
  const decoded = decodePng(png);
  const resized = resizeRgba(decoded, width, height);
  return encodePng(resized.width, resized.height, resized.rgba);
}

/** Centre-crops to the requested aspect ratio, then resizes. */
export function coverResizePng(png: Buffer, width: number, height: number): Buffer {
  const decoded = decodePng(png);
  const targetAspect = width / height;
  const sourceAspect = decoded.width / decoded.height;
  let cropW = decoded.width;
  let cropH = decoded.height;
  if (sourceAspect > targetAspect) cropW = Math.round(decoded.height * targetAspect);
  else cropH = Math.round(decoded.width / targetAspect);
  const offsetX = Math.floor((decoded.width - cropW) / 2);
  const offsetY = Math.floor((decoded.height - cropH) / 2);

  const cropped = new Uint8Array(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    const srcStart = ((y + offsetY) * decoded.width + offsetX) * 4;
    cropped.set(decoded.rgba.subarray(srcStart, srcStart + cropW * 4), y * cropW * 4);
  }
  const resized = resizeRgba({ width: cropW, height: cropH, rgba: cropped }, width, height);
  return encodePng(resized.width, resized.height, resized.rgba);
}

/** Applies a circular/rounded mask, used for adaptive launcher icon foregrounds. */
export function roundedMaskPng(png: Buffer, cornerRadiusRatio: number): Buffer {
  const img = decodePng(png);
  const rgba = Uint8Array.from(img.rgba);
  const r = Math.min(img.width, img.height) * Math.max(0, Math.min(0.5, cornerRadiusRatio));
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const nx = Math.min(Math.max(x + 0.5, r), img.width - r);
      const ny = Math.min(Math.max(y + 0.5, r), img.height - r);
      const d = Math.hypot(x + 0.5 - nx, y + 0.5 - ny);
      if (d <= r) continue;
      const i = (y * img.width + x) * 4;
      const falloff = Math.max(0, 1 - (d - r));
      rgba[i + 3] = Math.round((rgba[i + 3] as number) * falloff);
    }
  }
  return encodePng(img.width, img.height, rgba);
}
