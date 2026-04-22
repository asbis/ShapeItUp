// Mini flatbed knitting-printer — shared dimensions (mm)
//
// Design brief: 20-needle single-bed flatbed knitter, 3D-printable, concept test.
// Standard gauge (ISO 8188): 5 mm pitch. Cam angle 40-50 deg per textile ref.
// Carriage: 8 mm rails + LM8UU bearings + NEMA17 + idler pulley + GT2 belt.
// Selection: one solenoid per needle below the bed pushes a jack up against butt.
//
// Axis convention:
//   +X  carriage travel (along the length of the bed)
//   +Y  needle travel  (forward = yarn is caught; back = rest)
//   +Z  up             (bed-top face at Z = 0; everything below is -Z)

export const N_NEEDLES = 20;
export const NEEDLE_PITCH = 5.0;          // ISO 8188 standard gauge

// --- Bed ---------------------------------------------------------------------
export const BED_LENGTH = 140;            // X
export const BED_WIDTH = 60;              // Y
export const BED_THICKNESS = 8;           // Z (bed top at Z=0, bottom at -8)
export const SLOT_WIDTH = 1.2;            // Y-slot for needle stem
export const SLOT_DEPTH = 4;              // into -Z, from top face
export const FIRST_NEEDLE_X = -((N_NEEDLES - 1) * NEEDLE_PITCH) / 2;  // -47.5

// --- Needle ------------------------------------------------------------------
export const NEEDLE_LENGTH = 40;          // along Y
export const NEEDLE_STEM_W = 1.0;         // along X (fits in SLOT_WIDTH with clearance)
export const NEEDLE_STEM_H = 2.5;         // along Z (sits inside 4 mm slot)
export const BUTT_W = 2.0;                // along X
export const BUTT_H = 3.0;                // along Z, protrudes ABOVE Z=0
export const BUTT_L = 3.0;                // along Y
export const BUTT_Y_OFFSET = -8;          // butt sits toward -Y (back) end of needle
export const HOOK_RADIUS = 1.2;           // front of needle hook
export const NEEDLE_REST_Y = -5;          // default needle Y offset (rest position)

// --- Rails + carriage --------------------------------------------------------
export const RAIL_DIAMETER = 8;           // LM8UU
export const RAIL_LENGTH = 220;           // X span, overruns bed on both ends
export const RAIL_Y_FRONT = 40;           // rail Y position (front, +Y)
export const RAIL_Y_BACK = -40;           // rail Y position (back, -Y)
export const RAIL_Z = 22;                 // rail center Z (above butts + clearance)

export const CARRIAGE_LENGTH = 60;        // X (carriage spans 12 needles)
export const CARRIAGE_WIDTH = 92;         // Y (spans both rails + margin)
export const CARRIAGE_THICKNESS = 20;     // Z (thick enough to host LM8UU along its center)
export const CARRIAGE_Z_BOTTOM = RAIL_Z - CARRIAGE_THICKNESS / 2;  // body Z centered on RAIL_Z

// --- Cam plate (mounts under carriage, engages butts) ------------------------
// Cam plate sits with its underside ~0.3 mm above the bed top, so the butts
// (which protrude to Z = BUTT_H - 0.5) poke up INTO the cam groove. The
// chevron-shaped groove cut through the plate pushes each butt along Y as
// the carriage travels along X.
export const CAM_LENGTH = 80;             // X (longer than carriage to hold cam profile)
export const CAM_WIDTH = 22;              // Y (just wide enough to cover butts)
export const CAM_THICKNESS = 5;           // Z
export const CAM_Z_BOTTOM = 0.3;          // 0.3 mm sliding clearance above bed top
export const CAM_Z_TOP = CAM_Z_BOTTOM + CAM_THICKNESS;
// Cam groove geometry: V-track on cam's underside that pushes butts along Y.
export const CAM_GROOVE_WIDTH = BUTT_L + 0.6;   // groove Y-width (butt slides in groove)
export const CAM_ANGLE_DEG = 45;                 // ISO 40-50 deg range
export const CAM_APEX_Y = CAM_WIDTH / 2 - 2.5;   // near +Y edge of cam (front, knit)
export const CAM_END_Y = -CAM_WIDTH / 2 + 2.5;   // near -Y edge of cam (back, rest)

// --- Solenoid bank (selector under the bed) ----------------------------------
export const SOL_BODY_DIAMETER = 10;      // typical small push-solenoid
export const SOL_BODY_LENGTH = 22;
export const SOL_PLUNGER_DIAMETER = 4;
export const SOL_PLUNGER_LENGTH = 8;
export const SOL_BANK_PITCH = NEEDLE_PITCH; // one solenoid per needle
export const SOL_BANK_TOP_Z = -BED_THICKNESS - 1;  // just under bed
export const SOL_BANK_BRACKET_T = 4;       // housing wall thickness

// --- End caps (rail supports + motor / idler mounts) -------------------------
export const ENDCAP_WALL_W = 80;          // Y
export const ENDCAP_WALL_H = 60;          // Z
export const ENDCAP_WALL_T = 5;           // X thickness
export const ENDCAP_BASE_W = 70;          // Y
export const ENDCAP_BASE_L = 30;          // X
export const ENDCAP_BASE_T = 5;           // Z
export const MOTOR_FACE_X = -(BED_LENGTH / 2 + 20);  // -90
export const IDLER_FACE_X =  (BED_LENGTH / 2 + 20);  // +90

// --- Base chassis ------------------------------------------------------------
export const CHASSIS_LENGTH = 240;        // X
export const CHASSIS_WIDTH = 90;          // Y
export const CHASSIS_THICKNESS = 6;       // Z
export const CHASSIS_TOP_Z = -BED_THICKNESS - SOL_BODY_LENGTH - 6;  // below the solenoid bank

// --- Yarn carrier ------------------------------------------------------------
export const YARN_ARM_L = 18;             // Y, reaches forward to drop yarn onto needles
export const YARN_ARM_T = 3;              // X thickness
export const YARN_ARM_H = 25;             // Z height
export const YARN_EYELET_DIA = 2.2;       // Ø2 yarn with clearance

// --- Belt + idler ------------------------------------------------------------
export const PULLEY_DIAMETER = 16;        // GT2 20T pulley
export const PULLEY_WIDTH = 8;
export const BELT_THICKNESS = 1.4;        // GT2
export const BELT_WIDTH = 6;              // GT2-6

// --- Colors ------------------------------------------------------------------
export const C_BED = "#c2a878";
export const C_NEEDLE = "#d9d9d9";
export const C_RAIL = "#8090a0";
export const C_CARRIAGE = "#5e8ca1";
export const C_CAM = "#b85a3c";
export const C_SOLENOID = "#333438";
export const C_SOL_BRACKET = "#4d5058";
export const C_ENDCAP = "#6d7178";
export const C_CHASSIS = "#8c9196";
export const C_YARN = "#e0b05a";
export const C_MOTOR = "#222428";
export const C_PULLEY = "#b5651d";
export const C_BELT = "#242424";
