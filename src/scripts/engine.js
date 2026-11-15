const vertexSource = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));

void main() {
  gl_Position = vec4(corners[gl_VertexID], 0., 1.);
}
`;

const fragmentSource = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec2 uBounds;
uniform float uPixelRatio;
uniform vec3 uSpheres[3];
uniform vec3 uFollowerState;
out vec4 outColor;

const vec3 background = vec3(209. / 255.);
const vec3 charcoal = vec3(31. / 255.);
const vec3 keyLight = normalize(vec3(-0.61, 0.69, 0.39));
const float blendWidth = 0.37;

float grain(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z) - 0.5;
}

float followerHeight(vec2 offset, float radius, out vec2 normalXY) {
  float stretch = uFollowerState.z;
  if (stretch < 0.0001) {
    normalXY = offset;
    return radius * radius - dot(offset, offset);
  }

  vec2 forward = uFollowerState.xy;
  vec2 across = vec2(-forward.y, forward.x);
  float axial = dot(offset, forward);
  float lateral = dot(offset, across);
  float inverseLength = inversesqrt(axial * axial + radius * radius);
  float side = axial * inverseLength;
  float sideSlope = radius * radius * inverseLength * inverseLength * inverseLength;

  // The rear stretches farther and narrows into a soft tail.
  float axialScale = 1. - stretch * (0.29 - 0.16 * side);
  float lateralScale = 1. + stretch * (0.25 - 0.12 * side);
  vec2 warped = vec2(axial * axialScale, lateral * lateralScale);

  // Differentiate the warped surface so the light follows the changing shape.
  float axialNormal = warped.x * (axialScale + axial * 0.16 * stretch * sideSlope)
                    - warped.y * lateral * 0.12 * stretch * sideSlope;
  normalXY = forward * axialNormal + across * (warped.y * lateralScale);
  return radius * radius - dot(warped, warped);
}

void main() {
  vec2 p = (2. * gl_FragCoord.xy / uResolution - 1.) * uBounds;
  vec2 offset = p - uSpheres[0].xy;
  float heightSquared = uSpheres[0].z * uSpheres[0].z - dot(offset, offset);
  vec2 normalXY = offset;

  // Each sphere defines z² = r² - x² - y². A smooth maximum joins their
  // surfaces, and the weighted offsets give the normal of the joined surface.
  for (int i = 1; i < 3; i++) {
    offset = p - uSpheres[i].xy;
    float radius = uSpheres[i].z;
    vec2 nextNormal = offset;
    float next = radius * radius - dot(offset, offset);
    if (i == 2) next = followerHeight(offset, radius, nextNormal);
    float blend = clamp(0.5 + (next - heightSquared) / (2. * blendWidth), 0., 1.);
    heightSquared = mix(heightSquared, next, blend) + blendWidth * blend * (1. - blend);
    normalXY = mix(normalXY, nextNormal, blend);
  }

  float gradient = length(normalXY);
  float worldPerPixel = 2. * uBounds.y / uResolution.y;
  float edgeDistance = heightSquared / (2. * max(0.06, gradient) * worldPerPixel);
  float softness = clamp(7. + 22. * gradient, 9., 24.) * uPixelRatio;
  float coverage = smoothstep(-softness, 0.65 * softness, edgeDistance);
  if (coverage <= 0.) {
    outColor = vec4(background, 1.);
    return;
  }

  float depth = sqrt(max(0., heightSquared));
  vec3 normal = normalize(vec3(normalXY, max(0.0001, depth)));
  float light = dot(normal, keyLight);

  // Broad diffuse illumination, a soft highlight, and a faint reflected rim.
  float diffuse = smoothstep(-0.10, 1., light);
  float highlight = pow(max(0., light), 6.);
  float rim = pow(1. - normal.z, 4.) * (0.22 + 0.78 * diffuse);
  vec3 surface = charcoal * (0.49 + 2.0 * diffuse) + 0.23 * highlight + 0.105 * rim;
  surface = mix(vec3(0.12), surface, 1.5);
  vec3 exposure = mix(background, surface, coverage);
  float filmGrain = grain(vec3(floor(gl_FragCoord.xy), 3.));
  float texture = filmGrain * 0.225 * sqrt(exposure.r * coverage);
  outColor = vec4(exposure + texture, 1.);
}
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function positionDriftingSpheres(large, small, bounds, elapsed) {
  // The paths cross near the center early on, then drift out of sync.
  const largeTime = elapsed / 1.5 - 4.6;
  const smallTime = elapsed - 4.6;
  const horizontal = Math.sin(0.115 * largeTime + 0.14 * Math.sin(0.43 * largeTime));
  const vertical = Math.sin(0.147 * smallTime + 0.12);

  // At each outer turn the center reaches the edge while the other axis
  // keeps moving. The sphere goes about halfway off-screen and arcs back.
  large.x = bounds.x * horizontal;
  large.y = bounds.y * 0.72 * Math.sin(0.181 * largeTime + 0.35) * (1 - 0.23 * horizontal ** 2);
  small.x = -bounds.x * 0.88 * Math.sin(0.163 * smallTime) * (1 - 0.25 * vertical ** 2);
  small.y = bounds.y * vertical;
}

function moveFollower(follower, target, bounds, dt) {
  const follow = 1 - Math.exp(-4.6 * dt);
  const dx = (target.x * bounds.x - follower.x) * follow;
  const dy = (target.y * bounds.y - follower.y) * follow;
  follower.x += dx;
  follower.y += dy;

  // Filter the actual motion so the deformation trails both turns and stops.
  const scale = 1 / (Math.hypot(dx, dy) + 0.75 * dt);
  const relax = 1 - Math.exp(-5.2 * dt);
  follower.stretchX += (dx * scale - follower.stretchX) * relax;
  follower.stretchY += (dy * scale - follower.stretchY) * relax;
}

function mount(canvas, status) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const viewport = canvas.parentElement;
  const bounds = { x: 1, y: 1 };
  const pointer = { hasTarget: false, x: 0, y: 0, touchId: null };
  const large = { x: 0, y: 0, radius: 0.93 };
  const small = { x: 0, y: 0, radius: 0.48 };
  const restingPoint = { x: -0.08, y: -0.56 };
  const follower = { ...restingPoint, radius: 0.22, stretchX: 0, stretchY: 0 };
  const sphereUniforms = new Float32Array([0, 0, large.radius, 0, 0, small.radius, 0, 0, follower.radius]);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });

  if (!gl) {
    status.textContent = 'この表示には WebGL 2 に対応したブラウザが必要です。';
    return;
  }

  let renderer;
  let frameId = 0;
  let lastTime;
  let elapsed = 0;
  let viewportRect = viewport.getBoundingClientRect();
  let drawingSize = canvas.getBoundingClientRect();
  let devicePixelRatio;
  let projection;

  function resize() {
    if (!renderer || gl.isContextLost()) return;
    const { width: viewWidth, height: viewHeight } = viewportRect;
    const { width: drawWidth, height: drawHeight } = drawingSize;
    if (!viewWidth || !viewHeight || !drawWidth || !drawHeight) return;

    const shortest = Math.min(viewWidth, viewHeight);
    const nextX = viewWidth / shortest;
    const nextY = viewHeight / shortest;
    if (nextX !== bounds.x || nextY !== bounds.y) {
      follower.x *= nextX / bounds.x;
      follower.y *= nextY / bounds.y;
      bounds.x = nextX;
      bounds.y = nextY;
    }

    // Extend the projection into the blur padding without scaling the scene.
    const x = drawWidth / shortest;
    const y = drawHeight / shortest;
    devicePixelRatio = window.devicePixelRatio || 1;
    const pixelRatio = Math.min(devicePixelRatio, 1.5, Math.sqrt(1_650_000 / (drawWidth * drawHeight)));
    const width = Math.max(1, Math.round(drawWidth * pixelRatio));
    const height = Math.max(1, Math.round(drawHeight * pixelRatio));
    if (projection?.width === width && projection.height === height &&
        projection.x === x && projection.y === y && projection.pixelRatio === pixelRatio) return;

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(renderer.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(renderer.bounds, x, y);
    gl.uniform1f(renderer.pixelRatio, pixelRatio);
    projection = { width, height, x, y, pixelRatio };

    positionDriftingSpheres(large, small, bounds, elapsed);
    render();
  }

  function render() {
    if (!renderer || !projection || gl.isContextLost()) return;
    sphereUniforms[0] = large.x;
    sphereUniforms[1] = large.y;
    sphereUniforms[3] = small.x;
    sphereUniforms[4] = small.y;
    sphereUniforms[6] = follower.x;
    sphereUniforms[7] = follower.y;

    const stretch = Math.hypot(follower.stretchX, follower.stretchY);
    const inverseStretch = stretch >= 0.0001 ? 1 / stretch : 0;
    gl.uniform3f(renderer.followerState, follower.stretchX * inverseStretch, follower.stretchY * inverseStretch, stretch);
    gl.uniform3fv(renderer.spheres, sphereUniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    frameId = 0;
    const dt = Math.min((now - (lastTime ?? now)) / 1000, 0.05);
    lastTime = now;
    elapsed += dt;
    positionDriftingSpheres(large, small, bounds, elapsed);

    if (dt > 0) moveFollower(follower, pointer.hasTarget ? pointer : restingPoint, bounds, dt);
    render();
    schedule();
  }

  function schedule() {
    if (renderer && !motion.matches && !document.hidden && !frameId) {
      frameId = requestAnimationFrame(frame);
    }
  }

  function syncMotion() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    lastTime = undefined;
    clearTouch();
    canvas.toggleAttribute('data-static', motion.matches);
    if (motion.matches) {
      follower.stretchX = 0;
      follower.stretchY = 0;
      render();
    }
    schedule();
  }

  function movePointer(event) {
    if (motion.matches || !event.isPrimary) return;
    if (event.pointerType === 'touch' && pointer.touchId !== event.pointerId) return;
    const { left, top, width, height } = viewportRect;
    if (!width || !height) return;
    pointer.x = clamp(2 * (event.clientX - left) / width - 1, -1, 1);
    pointer.y = clamp(1 - 2 * (event.clientY - top) / height, -1, 1);
    pointer.hasTarget = true;
  }

  function clearTouch() {
    if (pointer.touchId === null) return;
    pointer.touchId = null;
    pointer.hasTarget = false;
  }

  function releasePointer(event) {
    if (pointer.touchId === event.pointerId) clearTouch();
  }

  function initialize() {
    try {
      renderer = createRenderer(gl);
      status.textContent = '';
      resize();
      syncMotion();
    } catch (error) {
      renderer = undefined;
      status.textContent = '球体の描画を開始できませんでした。';
      console.error(error);
    }
  }

  canvas.addEventListener('pointermove', movePointer);
  canvas.addEventListener('pointerdown', (event) => {
    if (motion.matches || !event.isPrimary) return;
    if (event.pointerType === 'touch') {
      pointer.touchId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
    }
    movePointer(event);
  });
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('lostpointercapture', releasePointer);
  window.addEventListener('blur', clearTouch);
  document.addEventListener('visibilitychange', syncMotion);
  motion.addEventListener('change', syncMotion);
  // Element sizes come from the observer. Window resize also catches DPR-only changes.
  window.addEventListener('resize', () => {
    if ((window.devicePixelRatio || 1) !== devicePixelRatio) resize();
  });
  const sizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === viewport) viewportRect = viewport.getBoundingClientRect();
      else drawingSize = entry.contentRect;
    }
    resize();
  });
  sizeObserver.observe(viewport);
  sizeObserver.observe(canvas);

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    renderer = undefined;
    projection = undefined;
    syncMotion();
    status.textContent = '球体の描画を復元しています。';
  });
  canvas.addEventListener('webglcontextrestored', initialize);
  initialize();
}

function createRenderer(gl) {
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create a WebGL program.');
  const shaders = [];
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Could not create a WebGL shader.');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    for (const shader of shaders) gl.detachShader(program, shader);

    // The fullscreen triangle uses gl_VertexID and needs no vertex buffers.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create a WebGL vertex array.');
    gl.bindVertexArray(vao);
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }

  gl.useProgram(program);
  return {
    resolution: gl.getUniformLocation(program, 'uResolution'),
    bounds: gl.getUniformLocation(program, 'uBounds'),
    pixelRatio: gl.getUniformLocation(program, 'uPixelRatio'),
    followerState: gl.getUniformLocation(program, 'uFollowerState'),
    spheres: gl.getUniformLocation(program, 'uSpheres[0]'),
  };
}

const canvas = document.querySelector('#drawing');
const status = document.querySelector('#status');

if (canvas && status) {
  mount(canvas, status);
}
