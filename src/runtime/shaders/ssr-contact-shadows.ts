/**
 * Screen-Space Reflections (SSR) and Contact Shadows for AAA-grade lighting.
 *
 * Adds:
 * - SSR for reflective surfaces (car paint, metal, glass)
 * - Ray-marched contact shadows for contact occlusion
 * - Fade-out at screen edges to hide artifacts
 * - Integrated into RenderPipeline as a ShaderPass
 */

import * as THREE from 'three';

/**
 * SSR shader: reflects the scene onto metallic/glossy surfaces.
 * Ray-marches in screen space to find reflections without RTT.
 */
export const SSRShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tPrevFrame: { value: null as THREE.Texture | null }, // temporal reprojection
    projectionMatrix: { value: new THREE.Matrix4() },
    projectionMatrixInv: { value: new THREE.Matrix4() },
    viewMatrix: { value: new THREE.Matrix4() },
    viewMatrixInv: { value: new THREE.Matrix4() },
    resolution: { value: new THREE.Vector2(1, 1) },
    intensity: { value: 0.4 },
    maxDistance: { value: 100 },
    maxSteps: { value: 64 },
    thickness: { value: 0.5 },
  },

  vertexShader: `
    varying vec2 vUv;
    
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform sampler2D tPrevFrame;
    uniform mat4 projectionMatrix;
    uniform mat4 projectionMatrixInv;
    uniform mat4 viewMatrix;
    uniform mat4 viewMatrixInv;
    uniform vec2 resolution;
    uniform float intensity;
    uniform float maxDistance;
    uniform float maxSteps;
    uniform float thickness;
    
    varying vec2 vUv;
    
    const float EPSILON = 0.001;
    
    // Decode depth from RGBA
    float decodeDepth(vec4 rgba) {
      return rgba.r + rgba.g / 255.0 + rgba.b / 65025.0;
    }
    
    // Reconstruct view position from depth
    vec3 getViewPosition(vec2 uv, float depth) {
      vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 viewPos = projectionMatrixInv * clipPos;
      return viewPos.xyz / viewPos.w;
    }
    
    // Ray march in screen space
    vec4 rayMarchSSR(vec3 viewPos, vec3 viewNormal, vec3 viewDir) {
      // Reflect ray
      vec3 reflectDir = reflect(viewDir, viewNormal);
      
      // March in view space
      vec3 marchPos = viewPos;
      float stepSize = maxDistance / maxSteps;
      float accumulated = 0.0;
      vec3 reflectColor = vec3(0.0);
      
      for (float i = 1.0; i < maxSteps; i += 1.0) {
        marchPos += reflectDir * stepSize;
        
        // Project to screen
        vec4 projectedPos = projectionMatrix * vec4(marchPos, 1.0);
        vec2 screenUv = (projectedPos.xy / projectedPos.w) * 0.5 + 0.5;
        
        // Out of screen
        if (screenUv.x < 0.0 || screenUv.x > 1.0 || screenUv.y < 0.0 || screenUv.y > 1.0) {
          break;
        }
        
        // Sample depth at this screen position
        float sampleDepth = decodeDepth(texture2D(tDepth, screenUv));
        vec3 surfacePos = getViewPosition(screenUv, sampleDepth);
        
        // Check if ray hit surface
        float diff = marchPos.z - surfacePos.z;
        if (diff > -thickness && diff < EPSILON) {
          // Hit! Sample color
          reflectColor = texture2D(tDiffuse, screenUv).rgb;
          accumulated = 1.0 - (i / maxSteps); // fade with distance
          break;
        }
      }
      
      return vec4(reflectColor, accumulated);
    }
    
    void main() {
      vec4 diffuse = texture2D(tDiffuse, vUv);
      vec4 normalData = texture2D(tNormal, vUv);
      vec4 depthData = texture2D(tDepth, vUv);
      
      vec3 normal = normalData.rgb * 2.0 - 1.0;
      float metallic = normalData.a;
      float depth = decodeDepth(depthData);
      
      vec3 viewPos = getViewPosition(vUv, depth);
      vec3 viewDir = normalize(viewPos);
      
      // Only compute SSR for metallic/reflective surfaces
      if (metallic > 0.3) {
        vec4 ssr = rayMarchSSR(viewPos, normal, viewDir);
        
        // Fade at screen edges
        vec2 edgeFade = smoothstep(0.0, 0.2, vUv) * smoothstep(1.0, 0.8, vUv);
        ssr.a *= edgeFade.x * edgeFade.y;
        
        // Blend with diffuse
        vec3 result = mix(diffuse.rgb, ssr.rgb, ssr.a * intensity * metallic);
        gl_FragColor = vec4(result, 1.0);
      } else {
        gl_FragColor = diffuse;
      }
    }
  `,
};

/**
 * Contact Shadows: ray-marched shadows where objects touch surfaces.
 * Adds depth and contact without baked shadows.
 */
export const ContactShadowsShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    lightDirection: { value: new THREE.Vector3(1, 1, 1).normalize() },
    lightIntensity: { value: 0.6 },
    maxDistance: { value: 0.5 },
    maxSteps: { value: 32 },
  },

  vertexShader: `
    varying vec2 vUv;
    
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tNormal;
    uniform vec3 lightDirection;
    uniform float lightIntensity;
    uniform float maxDistance;
    uniform float maxSteps;
    
    varying vec2 vUv;
    
    const float EPSILON = 0.001;
    
    float decodeDepth(vec4 rgba) {
      return rgba.r + rgba.g / 255.0 + rgba.b / 65025.0;
    }
    
    void main() {
      vec4 diffuse = texture2D(tDiffuse, vUv);
      vec4 normalData = texture2D(tNormal, vUv);
      vec4 depthData = texture2D(tDepth, vUv);
      
      vec3 normal = normalData.rgb * 2.0 - 1.0;
      
      // Ray march upward from this pixel toward the light
      float shadowStrength = 1.0;
      vec2 shadowUv = vUv;
      float stepSize = maxDistance / maxSteps;
      
      for (float i = 0.0; i < maxSteps; i += 1.0) {
        shadowUv += lightDirection.xy * stepSize * 0.01;
        
        if (shadowUv.x < 0.0 || shadowUv.x > 1.0 || shadowUv.y < 0.0 || shadowUv.y > 1.0) {
          break;
        }
        
        float shadowDepth = decodeDepth(texture2D(tDepth, shadowUv));
        float currentDepth = decodeDepth(depthData);
        
        // If we hit geometry above us, we're in shadow
        if (shadowDepth > currentDepth + EPSILON) {
          float fadeOut = 1.0 - (i / maxSteps);
          shadowStrength *= mix(1.0, 0.5, fadeOut * lightIntensity);
        }
      }
      
      // Apply shadow darkening
      vec3 shadowed = mix(diffuse.rgb, diffuse.rgb * 0.7, (1.0 - shadowStrength) * lightIntensity);
      gl_FragColor = vec4(shadowed, diffuse.a);
    }
  `,
};

/**
 * Compose SSR + Contact Shadows into the render pipeline.
 * Usage:
 *   const ssrPass = new ShaderPass(SSRShader);
 *   const contactPass = new ShaderPass(ContactShadowsShader);
 *   composer.addPass(ssrPass);
 *   composer.addPass(contactPass);
 */
export function createSSRPass(
  intensity: number = 0.4,
  maxDistance: number = 100,
  maxSteps: number = 64,
): THREE.ShaderPass {
  const pass = new (require('three/examples/jsm/postprocessing/ShaderPass').ShaderPass)(SSRShader);
  pass.uniforms.intensity.value = intensity;
  pass.uniforms.maxDistance.value = maxDistance;
  pass.uniforms.maxSteps.value = maxSteps;
  return pass;
}

export function createContactShadowsPass(
  lightDir: THREE.Vector3 = new THREE.Vector3(1, 1, 1).normalize(),
  intensity: number = 0.6,
  maxDistance: number = 0.5,
): THREE.ShaderPass {
  const pass = new (require('three/examples/jsm/postprocessing/ShaderPass').ShaderPass)(
    ContactShadowsShader,
  );
  pass.uniforms.lightDirection.value = lightDir;
  pass.uniforms.lightIntensity.value = intensity;
  pass.uniforms.maxDistance.value = maxDistance;
  return pass;
}
