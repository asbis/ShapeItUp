import { describe, it, expect } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";

// Validates the Rapier WASM dependency loads and simulates in Node/vitest before
// we build the real engine on top of it. A box dropped above a static floor must
// fall under gravity and come to rest on the floor.
describe("rapier dependency smoke", () => {
  it("a dynamic box falls onto a static floor and settles", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;

    // Static floor: top face at y = 0.
    const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.1, 10), floor);

    // Dynamic 1×1×1 box starting 5 m up.
    const box = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), box);

    const startY = box.translation().y;
    for (let i = 0; i < 240; i++) world.step();
    const endY = box.translation().y;

    expect(startY).toBeCloseTo(5, 1);
    expect(endY).toBeLessThan(startY); // it fell
    // Rests with its centre ~0.5 m above the floor top (half-height).
    expect(endY).toBeGreaterThan(0.35);
    expect(endY).toBeLessThan(0.75);

    world.free();
  });
});
