// Shared dimensions for the 20-needle mini flatbed knitting machine.
// Units: mm. Convention: bed along +X, needles point +Y, up +Z.
// Research-derived — see README / feedback doc for sources.

// --- Needles (Brother bulky "9mm" class) ----------------------------------
export const NEEDLE_COUNT       = 20;
export const PITCH              = 9.0;   // groove center-to-center
export const NEEDLE_LENGTH      = 150;
export const NEEDLE_DIAMETER    = 1.4;
export const BUTT_HEIGHT        = 1.5;   // above shaft top
export const BUTT_THICKNESS     = 1.2;   // across-bed
export const BUTT_LENGTH        = 2.5;   // along-needle
export const BUTT_FROM_BACK     = 40;    // distance from rear tail of needle

// --- Needle bed -----------------------------------------------------------
export const BED_LENGTH         = PITCH * (NEEDLE_COUNT + 4);   // 216 mm (2-needle margin each side)
export const BED_DEPTH          = 55;    // along Y (front-to-back)
export const BED_THICKNESS      = 12;
export const GROOVE_WIDTH       = NEEDLE_DIAMETER + 0.3;        // 1.7 mm — +0.15/side FDM clearance
export const GROOVE_DEPTH       = 3.0;
export const GROOVE_LENGTH      = 48;    // how far the groove runs in Y
export const GATE_PEG_HEIGHT    = 3.0;   // ridges above bed top, between grooves
export const GATE_PEG_WIDTH     = 1.2;

// --- Cam plate / carriage -------------------------------------------------
export const CAM_PLATE_THICKNESS    = 6;
export const CAM_FACE_ANGLE_DEG     = 45;
export const BUTT_LIFT_FULL         = 14;  // full clear travel
export const BUTT_LIFT_TUCK         = 7;
export const CAM_TRACK_HEIGHT       = BUTT_HEIGHT + 0.2;   // 1.7 mm closed-track slot
export const CARRIAGE_LENGTH        = 80;  // along X (direction of travel)
export const CARRIAGE_DEPTH         = 55;  // along Y (match bed)
export const CARRIAGE_WALL          = 4;
export const CARRIAGE_TOTAL_HEIGHT  = 32;
export const CARRIAGE_AIR_GAP       = 0.8; // clearance between cam-plate face and bed surface

// --- Rails + end caps -----------------------------------------------------
// Two rails stacked vertically on a single rear stanchion — keeps the
// footprint small and gives anti-rotation for a short carriage.
export const RAIL_DIAMETER          = 8;   // standard LM8UU linear rod
export const RAIL_LENGTH            = BED_LENGTH + 60;    // overrun both ends
export const RAIL_Y_BEHIND_BED      = -30; // both rails at this Y (bed frame)
export const RAIL_Z_LOWER           = 18;  // lower rail Z (bed-frame), near cam plate
export const RAIL_Z_UPPER           = 32;  // upper rail Z, gives 14 mm anti-rotation lever
export const END_CAP_LENGTH         = 25;  // X
export const END_CAP_HEIGHT         = 55;  // Z
export const END_CAP_DEPTH          = 70;  // Y

// --- Solenoid bank --------------------------------------------------------
export const SOLENOID_BODY_LENGTH   = 20;  // along the plunger axis (Y for this design — pushes needle butt sideways)
export const SOLENOID_BODY_DIAMETER = 10;  // cylindrical micro push-pull
export const SOLENOID_PLUNGER_STROKE = 4;
export const SOLENOID_PLUNGER_DIAMETER = 2;
export const SOLENOID_PITCH          = PITCH;  // one per needle
export const SOLENOID_BANK_LENGTH    = PITCH * NEEDLE_COUNT + 20;

// --- Yarn carrier ---------------------------------------------------------
export const YARN_EYELET_ID          = 2.0;
export const YARN_CARRIER_DROP       = 6;   // distance below the cam-plate's lowest face to the yarn eyelet

// --- Base chassis ---------------------------------------------------------
export const BASE_LENGTH             = BED_LENGTH + 60;   // 276 mm — full machine footprint
export const BASE_DEPTH              = 150;
export const BASE_THICKNESS          = 8;

// --- NEMA17 standards (duplicated from stdlib for explicit assembly math) -
export const NEMA17_BODY             = 42.3;
export const NEMA17_HEIGHT           = 40;
export const NEMA17_SHAFT_DIAMETER   = 5;
export const NEMA17_SHAFT_LENGTH     = 24;
export const NEMA17_BOLT_PITCH       = 31;  // bolt-hole grid M3

// Colors so each part gets a visually distinct tint in the assembly viewer.
export const COLORS = {
  bed:        "#b3b6bb",
  needle:     "#e6e1d8",
  cam:        "#ff9c3d",
  carriage:   "#5b6a7d",
  rail:       "#9a9a9a",
  endCap:     "#39434f",
  yarnArm:    "#c94f4f",
  solenoid:   "#222628",
  solMount:   "#3d3f42",
  stepper:    "#2b2b2b",
  pulley:     "#b5651d",
  belt:       "#141414",
  base:       "#2e3338",
  bracket:    "#6b7685",
} as const;
