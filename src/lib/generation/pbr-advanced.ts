/**
 * Advanced PBR texture generation with AAA-grade materials.
 *
 * Extends pbr.ts with:
 * - Anisotropic flake maps for metallic surfaces (2-layer paint with clearcoat)
 * - Detail normal maps (separately tileable fine geometry)
 * - Specular maps for direct control of reflectivity
 * - Layered material support (flake + base coat + clearcoat)
 */

import { fbm, valueNoise } from './raster';
import type { Rgb } from './color';
import { encodePng } from './png';

export interface AdvancedMaterialRecipe {
  readonly baseColor: Rgb;
  readonly metallic: number;
  readonly roughness: number;
  readonly relief: number;
  
  // --- Layer system ---
  readonly hasFlakes?: boolean;
  readonly flakeDensity?: number; // 0..1, how many flakes per area
  readonly flakeScale?: number; // size of each flake relative to texture
  readonly flakeAnisotropy?: number; // 0 = isotropic, 1 = fully directional
  readonly flakeDirection?: number; // 0..1, angle in texture space
  
  // --- Detail layer (added to normal map) ---
  readonly hasDetailNormals?: boolean;
  readonly detailScale?: number; // frequency of fine detail
  readonly detailStrength?: number; // how much detail shows
  
  // --- Specular control (for two-layer paint) ---
  readonly clearcoatStrength?: number; // separate clearcoat layer
  readonly clearcoatRoughness?: number;
}

/**
 * Generate anisotropic flake map: simulates microflakes in metallic paint.
 * Returns a map where each pixel is a flake "sparkle" strength.
 */
function generateFlakeMap(
  size: number,
  recipe: AdvancedMaterialRecipe,
  seed: number,
): Uint8Array {
  const flakes = new Uint8Array(size * size);
  const density = recipe.flakeDensity ?? 0.3;
  const scale = recipe.flakeScale ?? 0.08;
  const anisotropy = recipe.flakeAnisotropy ?? 0.6;
  const direction = recipe.flakeDirection ?? 0.5;
  
  const angleRad = direction * Math.PI;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // Rotate coordinates for anisotropic directionality
      const uRot = u * cosA - v * sinA;
      const vRot = u * sinA + v * cosA;

      // Multiple scales: large sparse flakes + small dense flakes
      const sparse = fbm(
        uRot / scale,
        vRot / (scale * (1 + anisotropy * 2)),
        seed,
        { octaves: 2, period: 16 }
      );
      
      const dense = fbm(
        uRot / (scale * 0.3),
        vRot / (scale * 0.3 * (1 + anisotropy)),
        seed + 17,
        { octaves: 3, period: 8 }
      );

      // Threshold to create discrete sparkles
      const sparkle = Math.max(0, sparse * 0.5 + dense * 0.5 - (1 - density)) / density;
      flakes[y * size + x] = Math.max(0, Math.min(255, Math.round(sparkle * 255)));
    }
  }

  return flakes;
}

/**
 * Generate detail normal map: fine surface features without adding triangles.
 * Separately tileable from the base normal, lets you layer details.
 */
function generateDetailNormalMap(
  size: number,
  recipe: AdvancedMaterialRecipe,
  seed: number,
): Uint8Array {
  const detailSize = Math.min(512, size);
  const detail = new Uint8Array(detailSize * detailSize * 4);
  const scale = recipe.detailScale ?? 200;
  const strength = recipe.detailStrength ?? 0.4;

  // Detail is a separate tileable texture with higher frequency
  for (let y = 0; y < detailSize; y++) {
    for (let x = 0; x < detailSize; x++) {
      const u = x / detailSize;
      const v = y / detailSize;

      // Very fine noise — simulates wear patterns, brush strokes, fabric weave
      const detail1 = fbm(u * scale, v * scale, seed, { octaves: 6, period: 8 });
      const detail2 = fbm(u * scale * 0.7, v * scale * 2, seed + 31, {
        octaves: 4,
        period: 12,
      });

      const combined = Math.abs(detail1 - 0.5) * 0.6 + Math.abs(detail2 - 0.5) * 0.4;
      const height = (combined - 0.5) * strength;

      // Approximate detail tangent-space normal (simplified Sobel on single point)
      const dx = fbm(u * scale + 0.01, v * scale, seed, { octaves: 2, period: 8 }) -
                 fbm(u * scale - 0.01, v * scale, seed, { octaves: 2, period: 8 });
      const dy = fbm(u * scale, v * scale + 0.01, seed, { octaves: 2, period: 8 }) -
                 fbm(u * scale, v * scale - 0.01, seed, { octaves: 2, period: 8 });

      const nx = -dx * strength * 2;
      const ny = -dy * strength * 2;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);

      detail[y * detailSize * 4 + x * 4] = Math.max(0, Math.min(255, (nx * inv * 0.5 + 0.5) * 255));
      detail[y * detailSize * 4 + x * 4 + 1] = Math.max(0, Math.min(255, (ny * inv * 0.5 + 0.5) * 255));
      detail[y * detailSize * 4 + x * 4 + 2] = Math.max(0, Math.min(255, (nz * inv * 0.5 + 0.5) * 255));
      detail[y * detailSize * 4 + x * 4 + 3] = 255;
    }
  }

  return detail;
}

/**
 * Generate specular/reflectance map: direct control over how reflective
 * different areas are. For car paint: 2-layer with base + clearcoat.
 */
function generateSpecularMap(
  size: number,
  recipe: AdvancedMaterialRecipe,
  seed: number,
): Uint8Array {
  const specular = new Uint8Array(size * size * 4);
  const clearcoat = recipe.clearcoatStrength ?? 1.0;
  const clearcoatRough = recipe.clearcoatRoughness ?? 0.05;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // Clearcoat layer uniformity (slight variation to avoid perfect plastic)
      const baseCoat = fbm(u * 3, v * 3, seed + 41, { octaves: 2, period: 16 });
      const coatVariation = (baseCoat - 0.5) * 0.1; // ±5% variation

      // Where clearcoat is strong, surface is more reflective and less rough
      const f0 = 0.04 * (1 + coatVariation); // Fresnel reflectance at 0°
      const roughMod = clearcoatRough + (1 - clearcoat) * (recipe.roughness - clearcoatRough);

      specular[y * size * 4 + x * 4] = Math.round((f0 * clearcoat) * 255); // F0
      specular[y * size * 4 + x * 4 + 1] = Math.round(roughMod * 255); // roughness override
      specular[y * size * 4 + x * 4 + 2] = Math.round(clearcoat * 255); // clearcoat strength
      specular[y * size * 4 + x * 4 + 3] = 255;
    }
  }

  return specular;
}

export interface AdvancedTextureSet {
  readonly albedo: Buffer; // base color
  readonly normal: Buffer; // base surface geometry
  readonly orm: Buffer; // occlusion/roughness/metallic
  readonly detailNormal?: Buffer; // fine detail (optional, tileable at 2-4×)
  readonly specular?: Buffer; // reflectance control (optional)
  readonly flakes?: Buffer; // sparkle/flake map (optional)
  readonly size: number;
}

export function generateAdvancedTextures(
  recipe: AdvancedMaterialRecipe,
  size: number = 512,
  seed: number = 0,
): AdvancedTextureSet {
  // TODO: integrate with existing pbr.ts
  // For now, returns structure that can be merged into glTF material
  
  const result: AdvancedTextureSet = {
    albedo: Buffer.alloc(0), // placeholder
    normal: Buffer.alloc(0), // placeholder
    orm: Buffer.alloc(0), // placeholder
    size,
  };

  if (recipe.hasFlakes) {
    const flakeData = generateFlakeMap(size, recipe, seed);
    result.flakes = encodePng(size, size, flakeData);
  }

  if (recipe.hasDetailNormals) {
    const detailData = generateDetailNormalMap(size, recipe, seed);
    result.detailNormal = detailData;
  }

  if (recipe.clearcoatStrength) {
    const specData = generateSpecularMap(size, recipe, seed);
    result.specular = specData;
  }

  return result;
}
