// Mini flatbed knitter — central spec
// Coordinate convention: bed runs along +X. Carriage traverses along +X.
// Needles point in +Y (hooks toward +Y, butts toward -Y). Z is up.
// Origin: center of the needle bed top face.

export const SPEC = {
  // ── Needle bed geometry ─────────────────────────────────────────
  needlePitch: 5.0,        // mm — E5 standard gauge (Brother/Passap)
  needleCount: 20,         // total selectable needles
  bedKnitLength: 100,      // = pitch × count
  bedOverrun: 50,          // each side, gives carriage room beyond knit zone
  bedLength: 200,          // bedKnitLength + 2×bedOverrun
  bedWidth: 50,            // depth of bed (Y)
  bedHeight: 20,           // bed body thickness (Z)

  // Trick (groove) — each needle slides in this slot
  trickWidth: 1.6,         // mm wide groove; clears the 1.2 mm needle stem with 0.2 mm side play
  trickDepth: 5.0,         // groove depth into bed top face
  trickLength: 70,         // along Y; needle's working slide path

  // Needle bed faceplate slot — captures latch needle laterally
  bedTopFilletEdge: 1.5,   // chamfer along bed top edges for safety
  bedMountBolt: "M4",      // bolts the bed to the chassis
  bedMountBoltCount: 4,
  bedMountInsetX: 25,      // from each end
  bedMountInsetY: 8,       // from front/back face

  // ── Latch needle ────────────────────────────────────────────────
  needleStemThk: 1.2,      // mm — vertical thickness of needle stem
  needleStemWid: 1.5,      // mm — width across (Z direction since needle is on its side)
  needleLength: 75,        // total length, hook to butt
  needleHookDia: 3.0,      // hook outer diameter
  needleHookWire: 0.8,     // hook wire diameter
  needleLatchLen: 6,       // latch length
  needleButtH: 4.0,        // butt projection above stem
  needleButtL: 3.0,        // butt length along needle
  needleSelectedZ: 4.0,    // butt rises this high when solenoid fires

  // ── Solenoid bank ──────────────────────────────────────────────
  solDia: 10,              // tubular solenoid body Ø
  solLen: 25,              // solenoid body length
  solPlungerDia: 4,        // plunger Ø
  solPlungerLen: 12,       // plunger extension when energized
  solBankPlateThk: 6,      // plate that holds the solenoid bank
  solBankPlateWidth: 40,   // Y depth of holding plate

  // ── Carriage ───────────────────────────────────────────────────
  carriageLength: 90,      // along X (travel axis)
  carriageWidth: 60,       // along Y (across needles)
  carriageHeight: 35,      // Z body height (above bed)
  carriageWallThk: 5,      // shell thickness
  carriagePlateThk: 6,     // top plate thickness
  carriageRailGap: 0.4,    // bushing fit clearance

  // ── Cam plate (mounted under carriage) ─────────────────────────
  camPlateLength: 80,
  camPlateWidth: 40,
  camPlateThk: 6,
  camAngleDeg: 45,         // raise/lower cam wedge angle
  camRiseHeight: 4.0,      // = needleSelectedZ — pushes butt over the apex
  camApproachLen: 18,      // ramp length per side

  // ── Linear rails ───────────────────────────────────────────────
  railDia: 8,              // mm steel rod
  railLength: 240,
  railSpacingY: 38,        // distance front-to-back between two rails
  railZ: 30,               // height of rail centerlines above chassis top

  // ── End caps (rail supports) ───────────────────────────────────
  endCapWidth: 40,
  endCapHeight: 50,
  endCapThk: 8,

  // ── Belt drive ─────────────────────────────────────────────────
  pulleyDia: 16,           // GT2-20T pulley
  pulleyHeight: 7.5,
  beltWidth: 6,            // GT2-6
  beltZ: 18,               // belt centerline above chassis

  // ── Chassis ────────────────────────────────────────────────────
  chassisLength: 280,
  chassisWidth: 120,
  chassisHeight: 6,        // base plate

  // ── Yarn carrier ───────────────────────────────────────────────
  yarnRailDia: 6,
  yarnRailLength: 240,
  yarnRailZ: 50,           // rail centerline above chassis (above bed)
  yarnCarrierLength: 30,
  yarnCarrierWidth: 14,
  yarnCarrierHeight: 18,
  yarnEyeDia: 1.6,         // yarn passes through this hole
} as const;

// Useful derived helpers
export const X_NEEDLE_OFFSET = (i: number) =>
  -SPEC.bedKnitLength / 2 + SPEC.needlePitch / 2 + i * SPEC.needlePitch;

export const BED_TOP_Z = 0;          // top face of bed at Z=0
export const BED_BOTTOM_Z = -SPEC.bedHeight;
export const CHASSIS_TOP_Z = BED_BOTTOM_Z;          // bed sits on chassis
export const CHASSIS_BOTTOM_Z = CHASSIS_TOP_Z - SPEC.chassisHeight;

// Color palette (Fusion-360 friendly)
export const COLORS = {
  steel: "#9ea7b0",
  aluminum: "#bcc3cb",
  printedDark: "#3a3f47",
  printedAccent: "#d97744",
  brass: "#c9a36a",
  copper: "#b87333",
  yarnRed: "#cf3a4a",
  motor: "#1f1f22",
  solenoid: "#5a5e66",
  belt: "#1a1a1a",
} as const;
