/**
 * The ViewCube — Fusion 360's corner navigator, and its behaviour.
 *
 * A small cube in the corner that shows which way the model is facing, and
 * that you steer with rather than read. Click a FACE for the orthogonal view
 * along it, an EDGE for the 45° view between two faces, a CORNER for an
 * isometric one. Drag it to orbit. The house takes you home.
 *
 * ## Why twenty-six meshes rather than one
 *
 * A single box would need the hit point classified after the fact — "which
 * components of the local coordinate are near the boundary" — with a
 * tolerance to tune and an edge band that drifts as the cube is rebuilt. The
 * 3 x 3 x 3 decomposition makes the regions THE GEOMETRY: the cell you hit is
 * the direction you asked for, carried on its own `userData`, and the
 * highlight is that mesh rather than a shape reconstructed to match it. The
 * cells butt up against each other, so it still reads as one solid cube until
 * you hover it — which is exactly when the regions should become visible.
 *
 * ## Why the hit target is an HTML element
 *
 * The cube is drawn into a corner of the main canvas — one WebGL context, one
 * render loop — but the pointer events have to be caught by something ABOVE
 * the canvas, or OrbitControls starts spinning the model the moment you press
 * on the cube. A transparent div over the same rectangle does that for free,
 * and gives the drag-to-orbit gesture somewhere to live.
 */
import * as THREE from "three";

/** How far along each axis a corner/edge cell reaches, of a half-side of 1. */
const EDGE_SPAN = 0.34;
const FACE_SPAN = 2 - 2 * EDGE_SPAN;
const CELL_OFFSET = FACE_SPAN / 2 + EDGE_SPAN / 2;

/**
 * One colour for all twenty-six cells.
 *
 * The first version tinted the edge and corner cells a shade darker, which
 * drew a grid over the whole thing and made it read as a stack of blocks
 * rather than as a cube. The regions are not supposed to be visible at rest —
 * they are supposed to appear under the cursor, which is the only moment they
 * mean anything.
 */
const CUBE_COLOR = 0xe3e7eb;
const HOVER_COLOR = 0x5aa9e6;
/** The twelve silhouette edges. What makes it read as a solid rather than a blob. */
const OUTLINE_COLOR = 0x5d666f;
const LABEL_COLOR = "#3a4048";

/**
 * The label each face carries, in this application's Z-up CAD frame.
 *
 * Keyed by the outward normal. -Y is FRONT because `setCameraAngle([0,-1,0])`
 * is what the front view has always meant here — the cube has to agree with
 * the keyboard shortcuts and the gnomon, not with a generic Y-up convention.
 */
const FACE_LABELS: Array<{ dir: [number, number, number]; text: string; up: [number, number, number] }> = [
  { dir: [0, 0, 1], text: "TOP", up: [0, 1, 0] },
  { dir: [0, 0, -1], text: "BOTTOM", up: [0, -1, 0] },
  { dir: [0, -1, 0], text: "FRONT", up: [0, 0, 1] },
  { dir: [0, 1, 0], text: "BACK", up: [0, 0, 1] },
  { dir: [1, 0, 0], text: "RIGHT", up: [0, 0, 1] },
  { dir: [-1, 0, 0], text: "LEFT", up: [0, 0, 1] },
];

export interface ViewCubeCallbacks {
  /** A face, edge or corner was clicked. The vector points model → camera. */
  onPick(dir: [number, number, number]): void;
  /** The cube was dragged, in CSS pixels. */
  onOrbit(dx: number, dy: number): void;
}

/** Below this, a press is a click rather than a drag. */
const DRAG_SLOP_PX = 3;

export class ViewCube {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly cells: THREE.Mesh[] = [];
  private readonly cubeMaterial: THREE.MeshLambertMaterial;
  private readonly hoverMaterial: THREE.MeshLambertMaterial;
  private readonly key: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private hovered: THREE.Mesh | null = null;

  private pressX = 0;
  private pressY = 0;
  private lastX = 0;
  private lastY = 0;
  private pressed = false;
  private dragged = false;

  constructor(
    private readonly hitEl: HTMLElement,
    private readonly callbacks: ViewCubeCallbacks,
  ) {
    // Orthographic and slightly wider than the cube's corner-to-corner reach,
    // so a corner-on view does not clip against the viewport edge.
    // The cube's half-diagonal is sqrt(3); anything tighter clips a corner-on
    // view, and every millimetre above it is legibility thrown away.
    const half = 1.78;
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 20);

    this.cubeMaterial = new THREE.MeshLambertMaterial({ color: CUBE_COLOR });
    // Pale rather than saturated, so the dark label on a hovered FACE stays
    // readable. A strong blue highlights the region and hides what it names.
    this.hoverMaterial = new THREE.MeshLambertMaterial({ color: HOVER_COLOR });

    this.buildCells();
    this.buildOutline();
    this.buildLabels();

    // Lit rather than flat: without shading the cube reads as a hexagon, and
    // the whole point of it is to look like a solid you are turning over.
    //
    // The key light FOLLOWS THE CAMERA, offset up and to the right. A rig
    // fixed in cube space is the obvious thing and it is wrong here: as you
    // orbit, it keeps finding orientations where two of the three visible
    // faces land on the same value and the cube goes flat. Anchored to the
    // view, the three faces you can see are always at three different angles
    // to the light, so the form reads from every direction.
    this.key = new THREE.DirectionalLight(0xffffff, 1.55);
    this.scene.add(this.key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.78));

    this.attach();
  }

  /** The 26 cells of a 3 x 3 x 3 block with the middle left out. */
  private buildCells(): void {
    const span = (i: number) => (i === 0 ? FACE_SPAN : EDGE_SPAN);
    const at = (i: number) => i * CELL_OFFSET;
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        for (const k of [-1, 0, 1]) {
          if (i === 0 && j === 0 && k === 0) continue;
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(span(i), span(j), span(k)),
            this.cubeMaterial,
          );
          mesh.position.set(at(i), at(j), at(k));
          mesh.userData.dir = [i, j, k] as [number, number, number];
          this.scene.add(mesh);
          this.cells.push(mesh);
        }
      }
    }
  }

  /**
   * The twelve edges of the cube, drawn as lines.
   *
   * A light cube on a dark background has a soft silhouette and no internal
   * definition — the near corner where three faces meet disappears entirely
   * when two of them happen to catch similar light. A thin dark outline gives
   * it the crispness a drawn object has, and costs one geometry.
   *
   * Nudged outward rather than depth-offset: the lines sit on the surface they
   * outline, and z-fighting on a shape this small flickers per pixel.
   */
  private buildOutline(): void {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: OUTLINE_COLOR }),
    );
    lines.scale.setScalar(1.004);
    lines.raycast = () => {};
    this.scene.add(lines);
    box.dispose();
  }

  /**
   * A text plane just outside each face.
   *
   * Built from an explicit basis rather than `lookAt`, because the label's UP
   * matters as much as its facing: TOP has to read with the back of the model
   * upward and BOTTOM with the front upward, or you turn the cube over and
   * find the word upside down.
   */
  private buildLabels(): void {
    for (const { dir, text, up } of FACE_LABELS) {
      const n = new THREE.Vector3(...dir);
      const u = new THREE.Vector3(...up);
      const right = new THREE.Vector3().crossVectors(u, n).normalize();
      const realUp = new THREE.Vector3().crossVectors(n, right).normalize();

      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(FACE_SPAN * 0.92, FACE_SPAN * 0.92),
        new THREE.MeshBasicMaterial({
          map: makeLabelTexture(text),
          transparent: true,
          depthWrite: false,
        }),
      );
      plane.setRotationFromMatrix(
        new THREE.Matrix4().makeBasis(right, realUp, n.clone()),
      );
      // Just proud of the face. Any further and it detaches at grazing angles;
      // any closer and it z-fights.
      plane.position.copy(n).multiplyScalar(1.006);
      // The cells own the picking. A label that answered would report the
      // face it sits on, which is right — but it would also mask the edge
      // cells it overhangs, which is not.
      plane.raycast = () => {};
      this.scene.add(plane);
    }
  }

  private attach(): void {
    this.hitEl.addEventListener("pointerdown", (e) => {
      this.pressed = true;
      this.dragged = false;
      this.pressX = this.lastX = e.clientX;
      this.pressY = this.lastY = e.clientY;
      this.hitEl.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    this.hitEl.addEventListener("pointermove", (e) => {
      if (!this.pressed) {
        this.setHover(this.pick(e));
        return;
      }
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (
        !this.dragged &&
        Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY) <= DRAG_SLOP_PX
      ) {
        return;
      }
      // Past the slop this is an orbit, and the highlight would be claiming a
      // click that is no longer going to happen.
      this.dragged = true;
      this.setHover(null);
      this.callbacks.onOrbit(dx, dy);
    });

    const release = (e: PointerEvent) => {
      if (!this.pressed) return;
      this.pressed = false;
      this.hitEl.releasePointerCapture?.(e.pointerId);
      if (this.dragged) return;
      const hit = this.pick(e);
      if (hit) this.callbacks.onPick(hit.userData.dir as [number, number, number]);
    };
    this.hitEl.addEventListener("pointerup", release);
    this.hitEl.addEventListener("pointercancel", () => {
      this.pressed = false;
      this.dragged = false;
    });
    this.hitEl.addEventListener("pointerleave", () => this.setHover(null));
  }

  private pick(e: { clientX: number; clientY: number }): THREE.Mesh | null {
    const rect = this.hitEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.cells, false);
    return (hits[0]?.object as THREE.Mesh) ?? null;
  }

  private setHover(mesh: THREE.Mesh | null): void {
    if (mesh === this.hovered) return;
    if (this.hovered) this.hovered.material = this.cubeMaterial;
    this.hovered = mesh;
    if (mesh) mesh.material = this.hoverMaterial;
    this.hitEl.style.cursor = mesh ? "pointer" : "";
  }

  /**
   * Turn the cube to match the view.
   *
   * The camera moves rather than the cube: keeping the cube's own axes aligned
   * with the model's is what lets a cell's `[i, j, k]` be handed straight to
   * `setCameraAngle` without a change of basis.
   */
  syncTo(mainCamera: THREE.Camera, target: THREE.Vector3): void {
    const dir = mainCamera.position.clone().sub(target);
    if (dir.lengthSq() === 0) return;
    this.camera.position.copy(dir.normalize().multiplyScalar(6));
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    // Up and to the right of the eye — the standard key-light placement, and
    // the reason all three visible faces stay at distinct values.
    const right = new THREE.Vector3()
      .crossVectors(this.camera.position, this.camera.up)
      .normalize();
    this.key.position
      .copy(this.camera.position)
      .addScaledVector(this.camera.up, 5)
      .addScaledVector(right, 3);
  }

  /**
   * Draw into a square at the bottom-right of the target.
   *
   * Leaves the viewport, scissor and autoClear exactly as it found them: this
   * runs between the main render and the next frame's clear, and a viewport
   * left clipped to the corner takes the whole model with it.
   */
  render(
    renderer: THREE.WebGLRenderer,
    targetW: number,
    size: number,
    marginRight: number,
    marginBottom: number,
  ): void {
    const prevViewport = new THREE.Vector4();
    renderer.getViewport(prevViewport);
    const prevScissor = new THREE.Vector4();
    renderer.getScissor(prevScissor);
    const prevScissorTest = renderer.getScissorTest();

    const x = targetW - size - marginRight;
    renderer.setViewport(x, marginBottom, size, size);
    renderer.setScissor(x, marginBottom, size, size);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
    renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
    renderer.setScissorTest(prevScissorTest);
  }
}

/**
 * A face label, drawn once into a canvas.
 *
 * The size is set by the LONGEST label, not by each word: six words each
 * grown to fill its own face reads as six differently-weighted buttons rather
 * than as one object with six sides.
 *
 * Drawn at 256 px for a face that is roughly 35 px on screen, because the cube
 * turns — a label seen at a grazing angle is sampled far more finely across
 * one axis than the flat-on size suggests.
 */
const LONGEST_LABEL = "BOTTOM";

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const px = 256;
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, px, px);

  const font = (size: number) =>
    `700 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  // Measure the longest word once and scale so IT fits; every other label
  // then inherits that size.
  ctx.font = font(100);
  const widthAt100 = ctx.measureText(LONGEST_LABEL).width || 100;
  const size = Math.floor((100 * px * 0.76) / widthAt100);

  ctx.font = font(size);
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Tracked out a little, the way a label engraved on a tool is. Guarded
  // because letterSpacing is a recent 2D-context property and an older
  // webview would otherwise throw on the assignment.
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${Math.round(size * 0.06)}px`;
    ctx.font = font(size);
  } catch {
    /* untracked is fine */
  }
  ctx.fillText(text, px / 2, px / 2);

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
