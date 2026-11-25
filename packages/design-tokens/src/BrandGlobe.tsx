import * as React from 'react';
import * as THREE from 'three';

import { cn } from './cn';

/**
 * The NullSquare particle globe.
 *
 * Lives in the brand package because two products render it — the marketing
 * hero and the account surfaces — and a brand mark that exists twice is a brand
 * mark that eventually drifts. It takes `theme` as a prop rather than reading a
 * context so it stays app-agnostic; each product feeds it from its own theme.
 *
 * WebGL is optional: if the context cannot be created or is lost, the component
 * degrades to a drawn wireframe rather than leaving a hole in the layout, and
 * still fires `onReady` so a loader gating on it can never trap.
 */

const BASE_TILT = Math.PI / 2;
const INNER_SPEED = { x: 0.02, y: 0.004 };
const CAMERA_Z = 4;
const PARTICLE_COUNT = 3200;
const GLOBE_RADIUS = 2.1;
const DOT_COLORS = {
  dark: '#94a3b8',
  light: '#111827',
} as const;
const GL_OPTIONS = {
  alpha: true,
  // Points use a soft sprite texture, so multisample edge antialiasing adds
  // considerable full-screen fill cost without a visible quality benefit.
  antialias: false,
  powerPreference: 'high-performance' as WebGLPowerPreference,
};

const getPixelRatio = () => {
  if (typeof window === 'undefined') return 1;
  const cap = window.innerWidth < 768 ? 1.25 : 1.5;
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), cap);
};

const seededRandom = (seed: number) => {
  const value = Math.sin(seed) * 10000;
  return value - Math.floor(value);
};

// Soft circular sprite so points render as round dots (not squares) regardless
// of three version — a white radial-gradient used as the point's alpha mask.
const createCircleTexture = () => {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
};

const createGlobeParticles = () => {
  const positions = new Float32Array(PARTICLE_COUNT * 3);

  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    const theta = (seededRandom(index * 2 + 1) - 0.5) * 360;
    const phi = (seededRandom(index * 2 + 2) - 0.5) * 360;

    positions[index * 3] = GLOBE_RADIUS * Math.sin(theta) * Math.cos(phi);
    positions[index * 3 + 1] = GLOBE_RADIUS * Math.sin(theta) * Math.sin(phi);
    positions[index * 3 + 2] = GLOBE_RADIUS * Math.cos(theta);
  }

  return positions;
};

const GlobeFallback: React.FC<{ visible: boolean }> = ({ visible }) => (
  <div
    aria-hidden="true"
    className={cn(
      'absolute inset-0 flex items-center justify-center md:justify-end pe-0 md:pe-[8vw] transition-opacity duration-300',
      visible ? 'opacity-100' : 'opacity-0',
    )}
  >
    <div className="relative h-[min(72vw,720px)] w-[min(72vw,720px)] rounded-full border border-black/10 dark:border-white/10 md:me-[-8vw]">
      <div className="absolute inset-[12%] rounded-full border border-black/10 dark:border-white/10" />
      <div className="absolute inset-[24%] rounded-full border border-black/5 dark:border-white/5" />
      <div className="absolute left-1/2 top-0 h-full w-px bg-black/10 dark:bg-white/10" />
      <div className="absolute left-0 top-1/2 h-px w-full bg-black/10 dark:bg-white/10" />
      <div className="absolute inset-x-[14%] top-[28%] h-px bg-black/5 dark:bg-white/5" />
      <div className="absolute inset-x-[14%] bottom-[28%] h-px bg-black/5 dark:bg-white/5" />
    </div>
  </div>
);

export interface BrandGlobeProps {
  /** Drives the dot ramp and, unless `className` overrides it, the blend treatment. */
  theme: 'dark' | 'light';
  /** Fires once the first frame has rendered, or immediately if WebGL is unavailable. */
  onReady?: () => void;
  /**
   * Replaces the theme-derived opacity and blend classes. Pass this when the
   * globe sits on a surface that does not follow the app theme — an always-dark
   * panel, for instance — where the default multiply/screen blend is wrong.
   */
  className?: string;
  /** Shrinks the sphere so a fixed-FOV camera does not crop it in tight columns. */
  scale?: number;
}

const BrandGlobeComponent: React.FC<BrandGlobeProps> = ({ theme, onReady, className, scale }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const restoreTimerRef = React.useRef<number | null>(null);
  const isMountedRef = React.useRef(false);
  const particlePositions = React.useMemo(() => createGlobeParticles(), []);
  const [canvasRevision, setCanvasRevision] = React.useState(0);
  const [webglUnavailable, setWebglUnavailable] = React.useState(false);

  const dotColor = DOT_COLORS[theme];

  // On narrow/portrait phones the fixed-FOV camera crops the sphere, so it
  // reads as "too zoomed in". Scale the globe down on mobile so it fits in view.
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768,
  );

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (restoreTimerRef.current) {
        window.clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (webglUnavailable) onReady?.();
  }, [onReady, webglUnavailable]);

  const scheduleContextRecovery = React.useCallback(() => {
    if (!isMountedRef.current) return;
    setWebglUnavailable(true);
    if (restoreTimerRef.current) window.clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = window.setTimeout(() => {
      if (!isMountedRef.current) return;
      setCanvasRevision((revision) => revision + 1);
      setWebglUnavailable(false);
      restoreTimerRef.current = null;
    }, 350);
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || webglUnavailable) return undefined;

    let animationFrame = 0;
    let disposed = false;
    let readySent = false;
    let isVisible = true;
    let documentVisible = document.visibilityState !== 'hidden';
    const globeScale = scale ?? (isMobile ? 0.62 : 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    camera.position.z = CAMERA_Z;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, ...GL_OPTIONS });
    } catch {
      setWebglUnavailable(true);
      onReady?.();
      return undefined;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setPixelRatio(getPixelRatio());

    const root = new THREE.Group();
    root.rotation.z = BASE_TILT;
    root.scale.setScalar(globeScale);

    const inner = new THREE.Group();
    root.add(inner);
    scene.add(root);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

    const sprite = createCircleTexture();
    const material = new THREE.PointsMaterial();
    material.map = sprite;
    material.alphaTest = 0.01;
    material.color = new THREE.Color(dotColor);
    material.size = 0.015;
    material.sizeAttenuation = true;
    material.depthWrite = false;
    material.opacity = 0.95;
    material.transparent = true;

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    inner.add(points);

    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setPixelRatio(getPixelRatio());
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) scheduleContextRecovery();
    };

    const handleContextRestored = () => {
      if (!disposed) {
        setCanvasRevision((revision) => revision + 1);
      }
    };

    const visibilityObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          isVisible = entries.some((entry) => entry.isIntersecting);
        });
    visibilityObserver?.observe(container);
    const handleVisibilityChange = () => {
      documentVisible = document.visibilityState !== 'hidden';
    };

    const animate = (time: number) => {
      if (disposed) return;
      const gl = renderer.getContext();
      if (gl.isContextLost()) {
        scheduleContextRecovery();
        return;
      }

      if (isVisible && documentVisible) {
        const elapsed = time / 1000;
        inner.rotation.x = BASE_TILT + elapsed * INNER_SPEED.x;
        inner.rotation.y = elapsed * INNER_SPEED.y;
        renderer.render(scene, camera);
      }

      if (!readySent) {
        readySent = true;
        requestAnimationFrame(() => {
          if (!disposed) onReady?.();
        });
      }

      animationFrame = requestAnimationFrame(animate);
    };

    resize();
    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    animationFrame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener('webglcontextlost', handleContextLost, false);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      visibilityObserver?.disconnect();
      geometry.dispose();
      material.dispose();
      sprite.dispose();
      renderer.dispose();
    };
  }, [
    canvasRevision,
    dotColor,
    isMobile,
    onReady,
    particlePositions,
    scale,
    scheduleContextRecovery,
    webglUnavailable,
  ]);

  const themeTreatment =
    theme === 'dark'
      ? 'opacity-40 md:opacity-60 mix-blend-screen'
      : 'opacity-50 md:opacity-80 mix-blend-multiply';

  return (
    <div
      ref={containerRef}
      className={cn('absolute inset-0 z-0 pointer-events-none', className ?? themeTreatment)}
    >
      <GlobeFallback visible={webglUnavailable} />
      {!webglUnavailable && (
        <canvas
          key={canvasRevision}
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full"
        />
      )}
    </div>
  );
};

export const BrandGlobe = React.memo(BrandGlobeComponent);
BrandGlobe.displayName = 'BrandGlobe';
