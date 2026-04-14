import { draw, drawRectangle, sketchCircle, makeCylinder } from "replicad";

// SG90 Micro Servo with cross horn — dimensions verified from ledalert/cadmodel-sg90 OpenSCAD source
// and community caliper measurements (hole pitch, arm span, spline).
export default function main() {
  // ── Servo body ─────────────────────────────────────────────────────────────
  const bodyW = 22.5;  // from OpenSCAD source
  const bodyD = 12.2;
  const bodyH = 22.5;

  const body = drawRectangle(bodyW, bodyD).sketchOnPlane("XY").extrude(bodyH);

  // Mounting ears: 32.2 × 12.2 × 2 mm, base at z = 16.75 (body protrudes ~4 mm above them)
  const earTotalW = 32.2;
  const earThick = 2;
  const earZ = 16.75;
  const ears = drawRectangle(earTotalW, bodyD)
    .sketchOnPlane("XY", [0, 0, earZ])
    .extrude(earThick);

  // Mounting holes Ø2 mm, 2 mm inset from outer edge of each ear
  const holeX = earTotalW / 2 - 2; // = 14.1 mm from centre
  const hole1 = makeCylinder(1, earThick, [holeX, 0, earZ], [0, 0, 1]);
  const hole2 = makeCylinder(1, earThick, [-holeX, 0, earZ], [0, 0, 1]);

  // Circular shaft-housing boss on top of body (Ø12 mm, 3.5 mm tall)
  const housingH = 3.5;
  const housing = sketchCircle(6).extrude(housingH).translateZ(bodyH);

  // Output shaft: Ø4.8 mm, 21-tooth spline (approximated as cylinder), 4 mm tall
  const shaftH = 4;
  const shaft = sketchCircle(2.4).extrude(shaftH).translateZ(bodyH + housingH);

  const servoBody = body
    .fuse(ears)
    .cut(hole1)
    .cut(hole2)
    .fuse(housing)
    .fuse(shaft);

  // ── Cross horn ─────────────────────────────────────────────────────────────
  // Verified dimensions: hub Ø8 mm × 4 mm, 4 arms spanning Ø28 mm,
  // arm thickness 2 mm, tapers 5 mm → 3 mm, holes Ø1.5 mm at r = 5 / 9 / 12 mm.
  const hornZ = bodyH + housingH + shaftH; // horn base = top of shaft = z 30 mm

  const hubR = 4;      // hub radius → 8 mm outer diameter
  const hubH = 4;      // hub rises 4 mm above arm plate
  const armLen = 14;   // centre → arm tip (total span 28 mm)
  const armBaseW = 5;  // arm width at hub junction
  const armTipW = 3;   // arm width at tip
  const armThick = 2;  // arm plate extrusion height

  // 2-D tapered cross profile (16-vertex closed polygon, all coords absolute)
  const crossProfile = draw([armLen, armTipW / 2])
    .lineTo([hubR,      armBaseW / 2])
    .lineTo([armBaseW / 2,  hubR])
    .lineTo([armTipW / 2,   armLen])
    .lineTo([-armTipW / 2,  armLen])
    .lineTo([-armBaseW / 2, hubR])
    .lineTo([-hubR,     armBaseW / 2])
    .lineTo([-armLen,   armTipW / 2])
    .lineTo([-armLen,  -armTipW / 2])
    .lineTo([-hubR,    -armBaseW / 2])
    .lineTo([-armBaseW / 2, -hubR])
    .lineTo([-armTipW / 2,  -armLen])
    .lineTo([armTipW / 2,   -armLen])
    .lineTo([armBaseW / 2,  -hubR])
    .lineTo([hubR,     -armBaseW / 2])
    .lineTo([armLen,   -armTipW / 2])
    .close();

  // cast to any: draw().close().sketchOnPlane().extrude() returns a broad
  // replicad union that loses fuse/cut; the geometry is still correct.
  const hornArms: any = crossProfile
    .sketchOnPlane("XY", [0, 0, hornZ])
    .extrude(armThick);

  // Hub cylinder (socket that grips the spline shaft)
  const hornHub = sketchCircle(hubR).extrude(hubH).translateZ(hornZ);

  let horn: any = hornArms.fuse(hornHub);

  // Ø1.5 mm holes in each arm at r = 5, 9, 12 mm — 3 per arm × 4 arms = 12 holes total
  for (const r of [5, 9, 12]) {
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      horn = horn.cut(
        makeCylinder(0.75, armThick + 0.1, [Math.cos(a) * r, Math.sin(a) * r, hornZ], [0, 0, 1])
      );
    }
  }

  // Centre Ø2 mm retention-screw hole through the full hub height
  horn = horn.cut(makeCylinder(1, hubH + 0.1, [0, 0, hornZ], [0, 0, 1]));

  // Return as two separate meshes so the viewer can colour them differently
  return [servoBody, horn];
}
