/**
 * Tests for the fat-line highlight material.
 *
 * `LineMaterial` computes its pixel width against a `resolution` uniform it
 * has to be TOLD. Get that wrong and nothing throws — the lines just come out
 * the wrong thickness, which is exactly the kind of failure a test should
 * catch instead of a person noticing weeks later.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { THEME, createEdgeHighlightMaterial, syncEdgeHighlightWidths } from "./theme";

describe("createEdgeHighlightMaterial", () => {
  it("sets a width in pixels, which a plain line material cannot", () => {
    // THREE.LineBasicMaterial's linewidth is WebGL's, which implementations
    // clamp to 1 — the reason this material exists at all.
    const select = createEdgeHighlightMaterial("select");
    expect(select).toBeInstanceOf(LineMaterial);
    expect(select.linewidth).toBe(THEME.edgeSelectWidth);
    expect(select.worldUnits).toBe(false);
  });

  it("makes selection heavier than hover, so the two read differently", () => {
    const select = createEdgeHighlightMaterial("select");
    const hover = createEdgeHighlightMaterial("hover");
    expect(select.linewidth).toBeGreaterThan(hover.linewidth);
    expect(select.opacity).toBeGreaterThan(hover.opacity);
    expect(select.color.getHex()).toBe(THEME.edgeSelectColor);
    expect(hover.color.getHex()).toBe(THEME.edgeHoverColor);
  });

  it("draws through the surface the edge belongs to", () => {
    // A highlight hidden behind its own solid is not a highlight.
    expect(createEdgeHighlightMaterial("select").depthTest).toBe(false);
  });
});

describe("syncEdgeHighlightWidths", () => {
  it("pushes the drawing-buffer size into every highlight in the group", () => {
    const group = new THREE.Group();
    const a = createEdgeHighlightMaterial("select");
    const b = createEdgeHighlightMaterial("hover");
    group.add(new THREE.Mesh(new THREE.BufferGeometry(), a));
    // Nested, because overlays are added as whole objects rather than flat.
    const inner = new THREE.Group();
    inner.add(new THREE.Mesh(new THREE.BufferGeometry(), b));
    group.add(inner);

    syncEdgeHighlightWidths(group, 1280, 720);

    expect(a.resolution.x).toBe(1280);
    expect(a.resolution.y).toBe(720);
    expect(b.resolution.x).toBe(1280);
  });

  it("leaves other materials alone", () => {
    const group = new THREE.Group();
    const plain = new THREE.MeshBasicMaterial();
    group.add(new THREE.Mesh(new THREE.BufferGeometry(), plain));
    // Would throw if it tried to set `resolution` on anything it found.
    expect(() => syncEdgeHighlightWidths(group, 800, 600)).not.toThrow();
  });

  it("handles an empty group", () => {
    expect(() => syncEdgeHighlightWidths(new THREE.Group(), 800, 600)).not.toThrow();
  });
});
