/**
 * arenaMarble.js — 场地大理石/岩石材质补丁。
 *
 * 场地 GLB 的烘焙贴图大面积平白，直接读作"白模"。这里给带贴图的场地
 * 材质注入世界空间的程序化石纹：
 *
 *  - 冷灰云石基色替换平白区域（带大尺度云雾状明暗）；
 *  - 双层大理石脉络（宽主脉 + 细次脉，走向不同、都被噪声推弯）；
 *  - 岩石颗粒；
 *  - 粗糙度调制：脉络与云雾处更光亮，其余偏磨砂，做出石材高光层次；
 *  - 只替换贴图亮部（白模感来源），暗部雕刻细节保持原样。
 *
 * 世界空间采样，跨合并网格连续；按材质 uuid 缓存，每个材质只注入一次。
 */
const _marblePatched = new Set();

export function patchMarble(material) {
  if (!material?.isMeshStandardMaterial || _marblePatched.has(material.uuid)) return;
  _marblePatched.add(material.uuid);

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying vec3 vArenaWorld;'
        ].join('\n')
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vArenaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        ].join('\n')
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying vec3 vArenaWorld;',
          'float arenaHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
          'float arenaNoise(vec2 p) {',
          '  vec2 i = floor(p);',
          '  vec2 f = fract(p);',
          '  vec2 u = f * f * (3.0 - 2.0 * f);',
          '  return mix(',
          '    mix(arenaHash(i), arenaHash(i + vec2(1.0, 0.0)), u.x),',
          '    mix(arenaHash(i + vec2(0.0, 1.0)), arenaHash(i + vec2(1.0, 1.0)), u.x),',
          '    u.y',
          '  );',
          '}',
          'float arenaFbm(vec2 p) {',
          '  float v = 0.0;',
          '  float a = 0.5;',
          '  for (int k = 0; k < 3; k++) {',
          '    v += a * arenaNoise(p);',
          '    p = p * 2.11 + vec2(17.3, 9.1);',
          '    a *= 0.5;',
          '  }',
          '  return v;',
          '}'
        ].join('\n')
      )
      .replace(
        '#include <map_fragment>',
        [
          '#include <map_fragment>',
          'float vArenaRough = 0.0; // 传给粗糙度段：脉络/云雾处的光亮权重',
          '{',
          '  vec2 q = vArenaWorld.xz * 0.32;',
          '  float w  = arenaFbm(q * 0.55);',
          '  float w2 = arenaFbm(q * 2.2 + 7.0);',
          '  // 大理石双层脉络：宽主脉 + 细次脉，走向不同、都被噪声推弯',
          '  float veinA = pow(0.5 + 0.5 * sin((q.x * 0.55 + q.y * 0.8) * 1.6 + w * 11.0), 3.0);',
          '  float veinB = pow(0.5 + 0.5 * sin((q.x * 1.3 - q.y * 0.7) * 2.6 + w2 * 13.0 + 2.1), 5.0);',
          '  float grain = arenaNoise(q * 9.0) * 0.6 + arenaNoise(q * 19.0) * 0.4;',
          '  // 冷灰云石基色（不再纯白），带云雾状明暗',
          '  vec3 base = mix(vec3(0.62, 0.645, 0.685), vec3(0.86, 0.87, 0.90),',
          '                  clamp(w * 0.75 + grain * 0.25, 0.0, 1.0));',
          '  // 脉络：灰蓝 → 深灰',
          '  vec3 veinCol = mix(vec3(0.36, 0.40, 0.48), vec3(0.55, 0.58, 0.66), w2);',
          '  base = mix(base, veinCol, clamp(veinA * 0.7 + veinB * 0.38, 0.0, 0.82));',
          '  base *= 0.93 + grain * 0.14;',
          '  // 只替换贴图的平白区域（白模感来源），暗部雕刻细节保持原样',
          '  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
          '  float whiteMask = smoothstep(0.22, 0.5, lum);',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, base, whiteMask * 0.88);',
          '  vArenaRough = veinA * 0.7 + w * 0.3; // 传给粗糙度段使用',
          '}'
        ].join('\n')
      )
      .replace(
        '#include <roughnessmap_fragment>',
        [
          '#include <roughnessmap_fragment>',
          '  // 石材高光层次：脉络与云雾处更光亮，其余偏磨砂',
          '  roughnessFactor = clamp(roughnessFactor * mix(1.08, 0.66, vArenaRough), 0.28, 1.0);'
        ].join('\n')
      );
  };
  material.customProgramCacheKey = () => 'arena-marble-v2';
  material.needsUpdate = true;
}
