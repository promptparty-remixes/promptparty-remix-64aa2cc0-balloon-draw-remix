import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PALETTE = {
  gold: '#d2a63c',
  silver: '#c3c7d3',
  pink: '#d783c7',
  red: '#b73f50',
  blue: '#4780cc',
  cyan: '#37d6ff',
  green: '#4ea86e',
  purple: '#6f4bb8',
  yellow: '#ffd84a',
};
const LAYER_DEPTH_SPACING = 120;

const vertexShader = `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = `
  uniform vec3 uColor;
  uniform vec3 uCameraPos;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 L = normalize(vec3(0.5, 0.9, 0.6));
    vec3 H = normalize(L + V);

    float ndl = max(dot(N, L), 0.0);
    float sideShade = pow(1.0 - abs(dot(N, V)), 1.5);
    float primarySpec = pow(max(dot(N, H), 0.0), 120.0);

    vec3 envDir = reflect(-V, N);
    float envStripe = pow(abs(envDir.y), 7.0) + 0.45 * pow(abs(envDir.x), 10.0);

    float wrinkle = hash(vUv * 30.0 + vec2(uTime * 0.1, 0.0));
    wrinkle = (wrinkle - 0.5) * 0.08;

    vec3 base = uColor * (0.35 + 0.65 * ndl);
    base *= (1.0 - sideShade * 0.32);

    vec3 foil = base + vec3(envStripe * 0.4) + vec3(primarySpec * 1.7);
    foil += vec3(wrinkle);

    gl_FragColor = vec4(foil, 1.0);
  }
`;

function pointsToWorld(points, width, height) {
  return points.map((p) => new THREE.Vector3(p.x - width / 2, height / 2 - p.y, 0));
}

function smoothAndResample(worldPoints, closed) {
  if (worldPoints.length < 2) return worldPoints;
  const curve = new THREE.CatmullRomCurve3(worldPoints, closed, 'catmullrom', 0.1);
  const sampleCount = Math.max(20, Math.floor(curve.getLength() / 4));
  return curve.getPoints(sampleCount);
}

function buildBalloonGeometry(centerline, width, closed) {
  const curve = new THREE.CatmullRomCurve3(centerline, closed, 'catmullrom', 0.1);
  const tubularSegments = Math.max(60, centerline.length * 2);
  const radialSegments = 24;
  const tube = new THREE.TubeGeometry(curve, tubularSegments, width * 0.5, radialSegments, closed);

  if (!closed) {
    const radius = width * 0.5;
    const startTangent = curve.getTangentAt(0).normalize();
    const endTangent = curve.getTangentAt(1).normalize();
    const up = new THREE.Vector3(0, 1, 0);

    const startCap = new THREE.SphereGeometry(radius, radialSegments, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    startCap.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, startTangent.clone().negate()));
    startCap.translate(centerline[0].x, centerline[0].y, centerline[0].z);

    const endCap = new THREE.SphereGeometry(radius, radialSegments, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    endCap.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, endTangent));
    endCap.translate(
      centerline[centerline.length - 1].x,
      centerline[centerline.length - 1].y,
      centerline[centerline.length - 1].z,
    );

    const merged = mergeGeometries([tube, startCap, endCap], true);
    merged.computeVertexNormals();
    tube.dispose();
    startCap.dispose();
    endCap.dispose();
    return merged;
  }

  return tube;
}

function createBalloonMesh(points, color, width, closed) {
  const geometry = buildBalloonGeometry(points, width, closed);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uCameraPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
    },
    vertexShader,
    fragmentShader,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.isBalloon = true;
  mesh.castShadow = false;
  return mesh;
}

function seededRandom(seed) {
  return fract(Math.sin(seed * 12.9898) * 43758.5453);
}

function fract(value) {
  return value - Math.floor(value);
}

function latticeNoise1D(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const smooth = f * f * (3 - 2 * f);
  const a = seededRandom(i * 17.123 + seed * 97.41);
  const b = seededRandom((i + 1) * 17.123 + seed * 97.41);
  return (a + (b - a) * smooth) * 2 - 1;
}

function getJiggleOffset(jiggle, timeSeconds) {
  const x = latticeNoise1D(timeSeconds * jiggle.speedX + jiggle.phaseX, jiggle.seedX);
  const y = latticeNoise1D(timeSeconds * jiggle.speedY + jiggle.phaseY, jiggle.seedY);
  const z = latticeNoise1D(timeSeconds * jiggle.speedZ + jiggle.phaseZ, jiggle.seedZ);
  const xFine = latticeNoise1D(timeSeconds * jiggle.speedX * 1.9 + jiggle.phaseY, jiggle.seedZ);
  const yFine = latticeNoise1D(timeSeconds * jiggle.speedY * 2.1 + jiggle.phaseZ, jiggle.seedX);
  const zFine = latticeNoise1D(timeSeconds * jiggle.speedZ * 1.7 + jiggle.phaseX, jiggle.seedY);

  return new THREE.Vector3(
    (x * 0.78 + xFine * 0.22) * jiggle.amplitude,
    (y * 0.78 + yFine * 0.22) * jiggle.amplitude,
    (z * 0.78 + zFine * 0.22) * jiggle.depthAmplitude,
  );
}

function createJiggleData(width) {
  const seedBase = Math.random() * 1000;
  const amplitude = Math.max(1.2, width * 0.08);
  return {
    amplitude,
    depthAmplitude: Math.max(0.5, amplitude * 0.35),
    speedX: 0.12 + Math.random() * 0.1,
    speedY: 0.11 + Math.random() * 0.1,
    speedZ: 0.08 + Math.random() * 0.08,
    phaseX: Math.random() * 100,
    phaseY: Math.random() * 100,
    phaseZ: Math.random() * 100,
    seedX: seedBase + 1.13,
    seedY: seedBase + 2.71,
    seedZ: seedBase + 4.37,
  };
}

function createPreviewLine(scene, points, color) {
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
  const line = new THREE.Line(geom, mat);
  scene.add(line);
  return line;
}

function createPopBurst(position) {
  const particleCount = 24;
  const positions = new Float32Array(particleCount * 3);
  const velocities = [];
  for (let i = 0; i < particleCount; i += 1) {
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;
    const angle = (i / particleCount) * Math.PI * 2;
    const speed = 2 + Math.random() * 3;
    velocities.push(new THREE.Vector3(Math.cos(angle) * speed, Math.sin(angle) * speed, (Math.random() - 0.5) * 2));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: '#fff2a8', size: 2.4, transparent: true, opacity: 1 });
  const points = new THREE.Points(geometry, material);
  points.userData = { velocities, age: 0, maxAge: 0.32 };
  return points;
}

function App() {
  const mountRef = useRef(null);
  const threeRef = useRef(null);
  const balloonMapRef = useRef(new Map());
  const layerGroupsRef = useRef(new Map());
  const pointerState = useRef({ drawing: false, points: [] });
  const previewRef = useRef(null);
  const redoRef = useRef([]);
  const layersRef = useRef([]);
  const selectedLayerRef = useRef(null);
  const dragStateRef = useRef({ active: false, balloonId: null, pointerId: null, lastWorldPoint: null });

  const [tool, setTool] = useState('draw');
  const [color, setColor] = useState('gold');
  const [width, setWidth] = useState(52);
  const [layers, setLayers] = useState([{ id: crypto.randomUUID(), name: 'Layer 1' }]);
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [layerPreviews, setLayerPreviews] = useState({});
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const widthRef = useRef(width);
  const layerCountRef = useRef(1);
  const previewRefreshFrameRef = useRef(null);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!selectedLayerId && layers[0]) {
      setSelectedLayerId(layers[0].id);
    }
  }, [layers, selectedLayerId]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    selectedLayerRef.current = selectedLayerId;
  }, [selectedLayerId]);

  useEffect(() => {
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor('#000000', 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#000000');

    const camera = new THREE.OrthographicCamera();
    camera.position.set(0, 0, 240);
    camera.lookAt(0, 0, 0);

    const hemi = new THREE.HemisphereLight('#f8f6ff', '#080808', 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight('#ffffff', 1.1);
    dir.position.set(120, 160, 220);
    scene.add(dir);

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const popBursts = [];

    function createLayerPreviewDataUrl() {
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = 64;
      previewCanvas.height = 64;
      const ctx = previewCanvas.getContext('2d');
      if (!ctx) return '';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.drawImage(renderer.domElement, 0, 0, previewCanvas.width, previewCanvas.height);
      return previewCanvas.toDataURL('image/png');
    }

    function refreshLayerPreviewsNow() {
      const orderedLayers = layersRef.current;
      if (!orderedLayers.length) {
        setLayerPreviews({});
        return;
      }
      const groups = [...layerGroupsRef.current.entries()];
      const visibility = new Map(groups.map(([id, group]) => [id, group.visible]));
      const nextPreviews = {};

      orderedLayers.forEach((layer) => {
        groups.forEach(([id, group]) => {
          group.visible = id === layer.id;
        });
        renderer.render(scene, camera);
        nextPreviews[layer.id] = createLayerPreviewDataUrl();
      });

      groups.forEach(([id, group]) => {
        group.visible = visibility.get(id) ?? true;
      });
      renderer.render(scene, camera);
      setLayerPreviews(nextPreviews);
    }

    function queueLayerPreviewRefresh() {
      if (previewRefreshFrameRef.current) return;
      previewRefreshFrameRef.current = requestAnimationFrame(() => {
        previewRefreshFrameRef.current = null;
        refreshLayerPreviewsNow();
      });
    }

    function resize() {
      const { clientWidth: w, clientHeight: h } = mount;
      renderer.setSize(w, h);
      camera.left = -w / 2;
      camera.right = w / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.near = 0.1;
      camera.far = 2000;
      camera.updateProjectionMatrix();
    }
    resize();

    let frame = 0;
    const animate = () => {
      frame += 1;
      const timeSeconds = frame * 0.016;
      scene.traverse((obj) => {
        if (obj.material?.uniforms?.uTime) {
          obj.material.uniforms.uTime.value = timeSeconds;
          obj.material.uniforms.uCameraPos.value.copy(camera.position);
        }
        if (obj.userData?.jiggle) {
          const offset = getJiggleOffset(obj.userData.jiggle, timeSeconds);
          const basePosition = obj.userData.basePosition ?? new THREE.Vector3();
          obj.position.copy(basePosition).add(offset);
        }
      });

      for (let i = popBursts.length - 1; i >= 0; i -= 1) {
        const burst = popBursts[i];
        const { age, maxAge, velocities } = burst.userData;
        const pos = burst.geometry.getAttribute('position');
        for (let p = 0; p < velocities.length; p += 1) {
          pos.setXYZ(
            p,
            pos.getX(p) + velocities[p].x,
            pos.getY(p) + velocities[p].y,
            pos.getZ(p) + velocities[p].z,
          );
        }
        pos.needsUpdate = true;
        burst.userData.age += 0.016;
        burst.material.opacity = Math.max(0, 1 - burst.userData.age / maxAge);
        if (age > maxAge) {
          scene.remove(burst);
          burst.geometry.dispose();
          burst.material.dispose();
          popBursts.splice(i, 1);
        }
      }

      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);

    function toCanvasPoint(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    }

    function toNdc(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      return pointerNdc;
    }

    function toWorldPoint(event) {
      const ndc = toNdc(event);
      return new THREE.Vector3(ndc.x, ndc.y, 0).unproject(camera);
    }

    function applyLayerOrdering() {
      const orderedLayers = layersRef.current;
      orderedLayers.forEach((layer, idx) => {
        const group = layerGroupsRef.current.get(layer.id);
        if (!group) return;
        group.position.z = -idx * LAYER_DEPTH_SPACING;
        group.renderOrder = orderedLayers.length - idx;
      });
    }

    function ensureLayerGroup(layerId) {
      if (layerGroupsRef.current.has(layerId)) {
        return layerGroupsRef.current.get(layerId);
      }
      const group = new THREE.Group();
      group.name = `layer-${layerId}`;
      scene.add(group);
      layerGroupsRef.current.set(layerId, group);
      applyLayerOrdering();
      return group;
    }

    function removeBalloon(balloon) {
      balloon.mesh.parent?.remove(balloon.mesh);
      balloon.mesh.geometry.dispose();
      balloon.mesh.material.dispose();
      balloonMapRef.current.delete(balloon.id);
    }

    function removeLayerAndBalloons(layerId) {
      const toRemove = [...balloonMapRef.current.values()].filter((balloon) => balloon.layerId === layerId);
      toRemove.forEach(removeBalloon);
      const group = layerGroupsRef.current.get(layerId);
      if (group) {
        scene.remove(group);
        layerGroupsRef.current.delete(layerId);
      }
      redoRef.current = redoRef.current.filter((balloon) => balloon.layerId !== layerId);
      queueLayerPreviewRefresh();
    }

    function buildBalloonObject(rawPoints) {
      const world = pointsToWorld(rawPoints, mount.clientWidth, mount.clientHeight);
      const closingDist = world[0].distanceTo(world[world.length - 1]);
      const currentWidth = widthRef.current;
      const currentColor = colorRef.current;
      const closed = rawPoints.length > 10 && closingDist < currentWidth * 1.2;
      const smoothed = smoothAndResample(world, closed);
      const mesh = createBalloonMesh(smoothed, PALETTE[currentColor], currentWidth, closed);
      const layerId = selectedLayerRef.current ?? layersRef.current[0]?.id;
      const layerGroup = ensureLayerGroup(layerId);
      layerGroup.add(mesh);
      mesh.geometry.computeBoundingSphere();
      const id = crypto.randomUUID();
      const balloon = {
        id,
        layerId,
        points: smoothed.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        color: PALETTE[currentColor],
        width: currentWidth,
        closed,
        mesh,
        bounds: mesh.geometry.boundingSphere?.clone() ?? new THREE.Sphere(),
        jiggle: createJiggleData(currentWidth),
        position: new THREE.Vector3(),
      };
      mesh.userData.jiggle = balloon.jiggle;
      mesh.userData.basePosition = balloon.position;
      balloonMapRef.current.set(id, balloon);
      redoRef.current = [];
      queueLayerPreviewRefresh();
    }

    function handlePointerDown(event) {
      if (toolRef.current === 'draw') {
        pointerState.current.drawing = true;
        pointerState.current.points = [toCanvasPoint(event)];
        return;
      }

      const ndc = toNdc(event);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects([...balloonMapRef.current.values()].map((b) => b.mesh), false);
      if (!hits[0]) return;
      const balloon = [...balloonMapRef.current.values()].find((b) => b.mesh === hits[0].object);
      if (!balloon) return;

      if (toolRef.current === 'drag') {
        dragStateRef.current = {
          active: true,
          balloonId: balloon.id,
          pointerId: event.pointerId,
          lastWorldPoint: toWorldPoint(event),
        };
        renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }

      const burst = createPopBurst(hits[0].point);
      popBursts.push(burst);
      scene.add(burst);
      removeBalloon(balloon);
      redoRef.current = [];
      queueLayerPreviewRefresh();
    }

    function handlePointerMove(event) {
      if (toolRef.current === 'draw') {
        if (!pointerState.current.drawing) return;
        const point = toCanvasPoint(event);
        const prev = pointerState.current.points[pointerState.current.points.length - 1];
        if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) > 2) {
          pointerState.current.points.push(point);
        }

        if (previewRef.current) {
          scene.remove(previewRef.current);
          previewRef.current.geometry.dispose();
          previewRef.current.material.dispose();
        }
        const worldPreview = pointsToWorld(pointerState.current.points, mount.clientWidth, mount.clientHeight);
        previewRef.current = createPreviewLine(scene, worldPreview, PALETTE[colorRef.current]);
        return;
      }

      if (toolRef.current !== 'drag' || !dragStateRef.current.active) return;
      const balloon = balloonMapRef.current.get(dragStateRef.current.balloonId);
      if (!balloon) return;
      const currentPoint = toWorldPoint(event);
      const deltaX = currentPoint.x - dragStateRef.current.lastWorldPoint.x;
      const deltaY = currentPoint.y - dragStateRef.current.lastWorldPoint.y;
      if (deltaX === 0 && deltaY === 0) return;

      balloon.position = balloon.position ?? new THREE.Vector3();
      balloon.position.x += deltaX;
      balloon.position.y += deltaY;
      balloon.points = balloon.points.map((p) => ({ ...p, x: p.x + deltaX, y: p.y + deltaY }));
      balloon.bounds.center.x += deltaX;
      balloon.bounds.center.y += deltaY;
      dragStateRef.current.lastWorldPoint = currentPoint;
    }

    function handlePointerUp(event) {
      if (toolRef.current === 'draw') {
        if (!pointerState.current.drawing) return;
        pointerState.current.drawing = false;
        if (previewRef.current) {
          scene.remove(previewRef.current);
          previewRef.current.geometry.dispose();
          previewRef.current.material.dispose();
          previewRef.current = null;
        }
        if (pointerState.current.points.length > 2) {
          buildBalloonObject(pointerState.current.points);
        }
        pointerState.current.points = [];
        return;
      }

      if (toolRef.current === 'drag' && dragStateRef.current.active) {
        const { pointerId } = dragStateRef.current;
        dragStateRef.current = { active: false, balloonId: null, pointerId: null, lastWorldPoint: null };
        if (pointerId !== null && renderer.domElement.hasPointerCapture(pointerId)) {
          renderer.domElement.releasePointerCapture(pointerId);
        }
        queueLayerPreviewRefresh();
      }
    }

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('resize', resize);

    threeRef.current = {
      scene,
      camera,
      renderer,
      mount,
      popBursts,
      raycaster,
      syncLayers: (nextLayers) => {
        const nextIds = new Set(nextLayers.map((layer) => layer.id));
        nextLayers.forEach((layer) => ensureLayerGroup(layer.id));
        [...layerGroupsRef.current.keys()]
          .filter((id) => !nextIds.has(id))
          .forEach((id) => removeLayerAndBalloons(id));
        applyLayerOrdering();
        queueLayerPreviewRefresh();
      },
      deleteLayer: (layerId) => {
        removeLayerAndBalloons(layerId);
      },
      undo: () => {
        const ids = [...balloonMapRef.current.keys()];
        const lastId = ids[ids.length - 1];
        if (!lastId) return;
        const balloon = balloonMapRef.current.get(lastId);
        removeBalloon(balloon);
        redoRef.current.push(balloon);
        queueLayerPreviewRefresh();
      },
      redo: () => {
        const balloon = redoRef.current.pop();
        if (!balloon) return;
        const layerId = layerGroupsRef.current.has(balloon.layerId)
          ? balloon.layerId
          : (selectedLayerRef.current ?? layersRef.current[0]?.id);
        const smoothed = balloon.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
        const mesh = createBalloonMesh(smoothed, balloon.color, balloon.width, balloon.closed);
        ensureLayerGroup(layerId).add(mesh);
        balloon.jiggle = balloon.jiggle ?? createJiggleData(balloon.width);
        balloon.position = balloon.position ?? new THREE.Vector3();
        mesh.userData.jiggle = balloon.jiggle;
        mesh.userData.basePosition = balloon.position;
        balloon.mesh = mesh;
        balloon.layerId = layerId;
        balloonMapRef.current.set(balloon.id, balloon);
        queueLayerPreviewRefresh();
      },
      duplicateLayerContent: (sourceLayerId, targetLayerId) => {
        const sourceBalloons = [...balloonMapRef.current.values()].filter((balloon) => balloon.layerId === sourceLayerId);
        const targetGroup = ensureLayerGroup(targetLayerId);
        sourceBalloons.forEach((sourceBalloon) => {
          const smoothed = sourceBalloon.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
          const mesh = createBalloonMesh(smoothed, sourceBalloon.color, sourceBalloon.width, sourceBalloon.closed);
          targetGroup.add(mesh);
          const id = crypto.randomUUID();
          const duplicated = {
            ...sourceBalloon,
            id,
            layerId: targetLayerId,
            mesh,
            jiggle: { ...(sourceBalloon.jiggle ?? createJiggleData(sourceBalloon.width)) },
          };
          duplicated.position = sourceBalloon.position?.clone() ?? new THREE.Vector3();
          mesh.userData.jiggle = duplicated.jiggle;
          mesh.userData.basePosition = duplicated.position;
          balloonMapRef.current.set(id, duplicated);
        });
        redoRef.current = [];
        queueLayerPreviewRefresh();
      },
      clear: () => {
        balloonMapRef.current.forEach(removeBalloon);
        balloonMapRef.current.clear();
        redoRef.current = [];
        queueLayerPreviewRefresh();
      },
      exportPng: () => {
        const link = document.createElement('a');
        link.download = `balloon-draw-${Date.now()}.png`;
        link.href = renderer.domElement.toDataURL('image/png');
        link.click();
      },
      refreshLayerPreviews: queueLayerPreviewRefresh,
    };

    queueLayerPreviewRefresh();

    return () => {
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('resize', resize);
      if (previewRefreshFrameRef.current) {
        cancelAnimationFrame(previewRefreshFrameRef.current);
      }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    threeRef.current?.syncLayers(layers);
  }, [layers]);

  function addLayer() {
    const nextCount = layerCountRef.current + 1;
    layerCountRef.current = nextCount;
    const newLayer = { id: crypto.randomUUID(), name: `Layer ${nextCount}` };
    setLayers((prev) => [newLayer, ...prev]);
    setSelectedLayerId(newLayer.id);
  }

  function renameLayer(layerId, name) {
    setLayers((prev) => prev.map((layer) => (layer.id === layerId ? { ...layer, name } : layer)));
  }

  function moveLayer(layerId, direction) {
    setLayers((prev) => {
      const idx = prev.findIndex((layer) => layer.id === layerId);
      if (idx < 0) return prev;
      const swapWith = idx + direction;
      if (swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next;
    });
  }

  function removeSelectedLayer() {
    if (!selectedLayerId) return;
    if (layers.length <= 1) return;
    const selectedIndex = layers.findIndex((layer) => layer.id === selectedLayerId);
    if (selectedIndex < 0) return;
    const fallback = layers[selectedIndex + 1] ?? layers[selectedIndex - 1];
    setLayers((prev) => prev.filter((layer) => layer.id !== selectedLayerId));
    threeRef.current?.deleteLayer(selectedLayerId);
    if (fallback) setSelectedLayerId(fallback.id);
  }

  function duplicateSelectedLayer() {
    if (!selectedLayerId) return;
    const selectedIndex = layers.findIndex((layer) => layer.id === selectedLayerId);
    if (selectedIndex < 0) return;
    const sourceLayer = layers[selectedIndex];
    const nextCount = layerCountRef.current + 1;
    layerCountRef.current = nextCount;
    const duplicatedLayer = {
      id: crypto.randomUUID(),
      name: `${sourceLayer.name} copy`,
    };
    setLayers((prev) => {
      const next = [...prev];
      next.splice(selectedIndex, 0, duplicatedLayer);
      return next;
    });
    setSelectedLayerId(duplicatedLayer.id);
    threeRef.current?.duplicateLayerContent(sourceLayer.id, duplicatedLayer.id);
  }

  return (
    <div className={`app ${tool === 'tack' ? 'tack-mode' : ''} ${tool === 'drag' ? 'drag-mode' : ''}`}>
      <div className="toolbar">
        <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>Draw</button>
        <button className={tool === 'drag' ? 'active' : ''} onClick={() => setTool('drag')}>✋ Drag</button>
        <button className={tool === 'tack' ? 'active' : ''} onClick={() => setTool('tack')}>📌 Tack</button>
        <div className="divider" />
        <label>
          Color
          <select value={color} onChange={(e) => setColor(e.target.value)}>
            {Object.keys(PALETTE).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Width
          <input type="range" min="52" max="104" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
        <button onClick={() => threeRef.current?.undo()}>Undo</button>
        <button onClick={() => threeRef.current?.redo()}>Redo</button>
        <button onClick={() => threeRef.current?.clear()}>Clear canvas</button>
        <button onClick={() => threeRef.current?.exportPng()}>Export PNG</button>
      </div>
      <div className="workspace">
        <div ref={mountRef} className="viewport" />
        <aside className="layers-pane">
          <div className="layers-pane-header">
            <h3>Layers</h3>
          </div>
          <ul className="layers-list">
            {layers.map((layer) => (
              <li
                key={layer.id}
                className={`layer-item ${selectedLayerId === layer.id ? 'active' : ''}`}
                onClick={() => setSelectedLayerId(layer.id)}
              >
                <img className="layer-thumb" src={layerPreviews[layer.id] || ''} alt={`${layer.name} preview`} />
                <input
                  className="layer-name"
                  value={layer.name}
                  onChange={(event) => renameLayer(layer.id, event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                />
                <span className="layer-selected-indicator">✓</span>
              </li>
            ))}
          </ul>
          <div className="layers-controls">
            <button onClick={addLayer}>＋ Add</button>
            <button onClick={removeSelectedLayer} disabled={layers.length <= 1}>🗑 Delete</button>
            <button onClick={duplicateSelectedLayer}>⧉ Duplicate</button>
            <button onClick={() => moveLayer(selectedLayerId, -1)}>↑ Move up</button>
            <button onClick={() => moveLayer(selectedLayerId, 1)}>↓ Move down</button>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
