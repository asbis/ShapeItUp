/**
 * Standards tables — ISO/DIN dimensions used across the ShapeItUp stdlib.
 *
 * Single source of truth. Every helper (holes, fasteners, bearings, extrusions)
 * reads from these tables so dimensions stay consistent and updating a standard
 * is a one-line change.
 *
 * All values in millimeters. Sources:
 *   - Socket head:   ISO 4762
 *   - Button head:   ISO 7380-1
 *   - Flat head:     ISO 10642 (90° countersunk)
 *   - Hex nut:       DIN 934 / ISO 4032
 *   - Flat washer:   DIN 125 / ISO 7089
 *   - Heat-set:      generic brass (Voron M3 standard: 4.2mm OD, 5mm depth)
 *   - Bearings:      deep-groove ball series (62x, 600x) + LMxUU linear
 *   - Extrusions:    Bosch 20/30/40 series (Misumi HFS compatible)
 */

export type MetricSize = "M2" | "M2.5" | "M3" | "M4" | "M5" | "M6" | "M8" | "M10" | "M12";

/** Socket head cap screw — ISO 4762. Most common machine screw in 3D-printed parts. */
export interface SocketHeadSpec {
  /** Shaft (thread) diameter, mm. */
  shaft: number;
  /** Head outer diameter, mm. */
  headD: number;
  /** Head height, mm. */
  headH: number;
  /** Hex socket across-flats, mm. */
  hex: number;
  /** Tap drill diameter for cutting an internal thread (coarse pitch), mm. */
  tapDrill: number;
  /** Clearance hole diameter, normal fit (ISO 273 H13), mm. */
  clearance: number;
}

export const SOCKET_HEAD: Record<MetricSize, SocketHeadSpec> = {
  "M2":   { shaft: 2.0,  headD: 3.8,  headH: 2.0,  hex: 1.5,  tapDrill: 1.6,  clearance: 2.4  },
  "M2.5": { shaft: 2.5,  headD: 4.5,  headH: 2.5,  hex: 2.0,  tapDrill: 2.05, clearance: 2.9  },
  "M3":   { shaft: 3.0,  headD: 5.5,  headH: 3.0,  hex: 2.5,  tapDrill: 2.5,  clearance: 3.4  },
  "M4":   { shaft: 4.0,  headD: 7.0,  headH: 4.0,  hex: 3.0,  tapDrill: 3.3,  clearance: 4.5  },
  "M5":   { shaft: 5.0,  headD: 8.5,  headH: 5.0,  hex: 4.0,  tapDrill: 4.2,  clearance: 5.5  },
  "M6":   { shaft: 6.0,  headD: 10.0, headH: 6.0,  hex: 5.0,  tapDrill: 5.0,  clearance: 6.6  },
  "M8":   { shaft: 8.0,  headD: 13.0, headH: 8.0,  hex: 6.0,  tapDrill: 6.8,  clearance: 9.0  },
  "M10":  { shaft: 10.0, headD: 16.0, headH: 10.0, hex: 8.0,  tapDrill: 8.5,  clearance: 11.0 }, // TODO verify against ISO 4762 spec
  "M12":  { shaft: 12.0, headD: 19.0, headH: 12.0, hex: 10.0, tapDrill: 10.2, clearance: 13.5 }, // TODO verify against ISO 4762 spec (headD: some sources say 18.0)
};

/** Button head cap screw — ISO 7380. Low-profile alternative to socket head. */
export interface ButtonHeadSpec {
  shaft: number;
  headD: number;
  headH: number;
  hex: number;
}

export const BUTTON_HEAD: Partial<Record<MetricSize, ButtonHeadSpec>> = {
  "M3":  { shaft: 3.0,  headD: 5.7,  headH: 1.65, hex: 2.0 },
  "M4":  { shaft: 4.0,  headD: 7.6,  headH: 2.2,  hex: 2.5 },
  "M5":  { shaft: 5.0,  headD: 9.5,  headH: 2.75, hex: 3.0 },
  "M6":  { shaft: 6.0,  headD: 10.5, headH: 3.3,  hex: 4.0 },
  "M8":  { shaft: 8.0,  headD: 14.0, headH: 4.4,  hex: 5.0 },
  "M10": { shaft: 10.0, headD: 17.5, headH: 5.5,  hex: 6.0 }, // TODO verify against ISO 7380-1 spec
  "M12": { shaft: 12.0, headD: 21.0, headH: 6.6,  hex: 8.0 }, // TODO verify against ISO 7380-1 spec
};

/** Hex head bolt — ISO 4017 (fully threaded). External hex, wrench-driven. */
export interface HexHeadSpec {
  shaft: number;
  /** Across-flats wrench size. */
  acrossFlats: number;
  /** Head height. */
  headH: number;
}

export const HEX_HEAD: Partial<Record<MetricSize, HexHeadSpec>> = {
  "M3":  { shaft: 3.0,  acrossFlats: 5.5,  headH: 2.0 },
  "M4":  { shaft: 4.0,  acrossFlats: 7.0,  headH: 2.8 },
  "M5":  { shaft: 5.0,  acrossFlats: 8.0,  headH: 3.5 },
  "M6":  { shaft: 6.0,  acrossFlats: 10.0, headH: 4.0 },
  "M8":  { shaft: 8.0,  acrossFlats: 13.0, headH: 5.3 },
  "M10": { shaft: 10.0, acrossFlats: 17.0, headH: 6.4 }, // TODO verify against ISO 4017 spec
  "M12": { shaft: 12.0, acrossFlats: 19.0, headH: 7.5 }, // TODO verify against ISO 4017 spec
};

/** Flat head (countersunk) cap screw — ISO 10642. 90° head angle. */
export interface FlatHeadSpec {
  shaft: number;
  /** Theoretical head OD at the plate surface. */
  headD: number;
  /** Head height (for reference — countersinks are cut to the headD instead). */
  headH: number;
  hex: number;
  /** Countersink total angle in degrees (included). */
  csAngle: 90;
}

export const FLAT_HEAD: Partial<Record<MetricSize, FlatHeadSpec>> = {
  "M3":  { shaft: 3.0,  headD: 6.72,  headH: 1.86, hex: 2.0,  csAngle: 90 },
  "M4":  { shaft: 4.0,  headD: 8.96,  headH: 2.48, hex: 2.5,  csAngle: 90 },
  "M5":  { shaft: 5.0,  headD: 11.20, headH: 3.10, hex: 3.0,  csAngle: 90 },
  "M6":  { shaft: 6.0,  headD: 13.44, headH: 3.72, hex: 4.0,  csAngle: 90 },
  "M8":  { shaft: 8.0,  headD: 17.92, headH: 4.96, hex: 5.0,  csAngle: 90 },
  "M10": { shaft: 10.0, headD: 19.68, headH: 5.84, hex: 8.0,  csAngle: 90 }, // TODO verify against ISO 10642 spec
  "M12": { shaft: 12.0, headD: 23.52, headH: 7.00, hex: 10.0, csAngle: 90 }, // TODO verify against ISO 10642 spec
};

/** Hex nut — DIN 934. */
export interface HexNutSpec {
  /** Across-flats width (wrench size), mm. */
  acrossFlats: number;
  /** Nut height, mm. */
  height: number;
  /** Thread through-hole, matches shaft diameter. */
  shaft: number;
}

export const HEX_NUT: Partial<Record<MetricSize, HexNutSpec>> = {
  "M3":  { acrossFlats: 5.5,  height: 2.4, shaft: 3.0  },
  "M4":  { acrossFlats: 7.0,  height: 3.2, shaft: 4.0  },
  "M5":  { acrossFlats: 8.0,  height: 4.0, shaft: 5.0  },
  "M6":  { acrossFlats: 10.0, height: 5.0, shaft: 6.0  },
  "M8":  { acrossFlats: 13.0, height: 6.5, shaft: 8.0  },
  "M10": { acrossFlats: 17.0, height: 8.0, shaft: 10.0 }, // TODO verify against DIN 934 / ISO 4032 spec
  "M12": { acrossFlats: 19.0, height: 10.0, shaft: 12.0 }, // TODO verify against DIN 934 / ISO 4032 spec
};

/** Flat washer — DIN 125. */
export interface FlatWasherSpec {
  id: number;
  od: number;
  thickness: number;
}

export const FLAT_WASHER: Partial<Record<MetricSize, FlatWasherSpec>> = {
  "M3":  { id: 3.2,  od: 7.0,  thickness: 0.5 },
  "M4":  { id: 4.3,  od: 9.0,  thickness: 0.8 },
  "M5":  { id: 5.3,  od: 10.0, thickness: 1.0 },
  "M6":  { id: 6.4,  od: 12.0, thickness: 1.6 },
  "M8":  { id: 8.4,  od: 16.0, thickness: 1.6 },
  "M10": { id: 10.5, od: 20.0, thickness: 2.0 }, // TODO verify against DIN 125 / ISO 7089 spec
  "M12": { id: 13.0, od: 24.0, thickness: 2.5 }, // TODO verify against DIN 125 / ISO 7089 spec
};

/** Heat-set threaded insert (brass, press-fit) — common 3D-printing standard. */
export interface HeatSetInsertSpec {
  /** Insert outer diameter — the pocket hole matches this + press-fit allowance. */
  od: number;
  /** Insert length — the pocket depth matches this exactly. */
  depth: number;
  /** Internal thread size it accepts. */
  thread: MetricSize;
}

export const HEAT_SET_INSERT: Partial<Record<MetricSize, HeatSetInsertSpec>> = {
  "M2": { od: 3.3, depth: 4.0, thread: "M2" },
  "M3": { od: 4.2, depth: 5.0, thread: "M3" },
  "M4": { od: 5.6, depth: 6.0, thread: "M4" },
  "M5": { od: 6.4, depth: 7.0, thread: "M5" },
};

/** Deep-groove ball bearing spec (e.g., 608, 625). */
export interface BallBearingSpec {
  /** Inner diameter (shaft fits here). */
  id: number;
  /** Outer diameter (seat is cut this wide). */
  od: number;
  /** Bearing width. */
  width: number;
}

export const BALL_BEARING: Record<string, BallBearingSpec> = {
  "623":  { id: 3,  od: 10, width: 4 },
  "624":  { id: 4,  od: 13, width: 5 },
  "625":  { id: 5,  od: 16, width: 5 },
  "626":  { id: 6,  od: 19, width: 6 },
  "608":  { id: 8,  od: 22, width: 7 },   // skate-bearing — most popular
  "6000": { id: 10, od: 26, width: 8 },
  "6001": { id: 12, od: 28, width: 8 },
  "6002": { id: 15, od: 32, width: 9 },
};

/** Linear bearing (LMxUU) — sliding bushing on a smooth rod. */
export interface LinearBearingSpec {
  /** Rod diameter. */
  id: number;
  /** Outer diameter. */
  od: number;
  /** Overall length. */
  length: number;
}

export const LINEAR_BEARING: Record<string, LinearBearingSpec> = {
  "LM4UU":  { id: 4,  od: 8,  length: 12 },
  "LM6UU":  { id: 6,  od: 12, length: 19 },
  "LM8UU":  { id: 8,  od: 15, length: 24 },
  "LM10UU": { id: 10, od: 19, length: 29 },
  "LM12UU": { id: 12, od: 21, length: 30 },
};

/** T-slot aluminum extrusion profile (Bosch/Misumi HFS 6-series compatible). */
export interface ExtrusionProfileSpec {
  /** Outer cross-section (square), mm. */
  size: number;
  /** T-slot mouth width, mm. */
  slotWidth: number;
  /** T-slot depth to the neck bottom, mm. */
  slotDepth: number;
  /** Center axial through-hole diameter, mm. */
  centerHole: number;
}

export const T_SLOT_EXTRUSION: Record<string, ExtrusionProfileSpec> = {
  "2020": { size: 20, slotWidth: 6.2, slotDepth: 6.0,  centerHole: 4.2 },
  "3030": { size: 30, slotWidth: 8.2, slotDepth: 8.0,  centerHole: 5.5 },
  "4040": { size: 40, slotWidth: 8.2, slotDepth: 10.0, centerHole: 7.0 },
};

/**
 * Fit policy — allowance added to nominal diameters when cutting holes.
 *
 * Values are **radial** allowance in mm (added to the nominal diameter, so a
 * "slip" clearance hole for an M3 shaft = 3.0 + 0.1 = 3.1mm). Defaults are
 * tuned for FDM 3D printing at 0.4mm nozzle; users can override per-hole.
 */
export type FitStyle = "press" | "slip" | "clearance" | "loose";

export const FIT: Record<FitStyle, number> = {
  press:     -0.05,  // interference (press-fit bearing/insert)
  slip:       0.10,  // rotating shaft / sliding fit
  clearance:  0.20,  // bolted clearance (default for holes.through)
  loose:      0.40,  // generous clearance for misaligned parts
};

/**
 * Shared point type used across the stdlib for positioning.
 * Matches Replicad's `Point` where possible.
 */
export type Point3 = [number, number, number];

/** NEMA stepper motor spec. Body is a square prism; shaft exits one face. */
export interface NemaMotorSpec {
  /** Body face size (square). */
  body: number;
  /** Body depth along the shaft axis. */
  height: number;
  /** Output shaft nominal diameter. */
  shaft: number;
  /** Typical exposed shaft length (varies by supplier — override per-part as needed). */
  shaftLength: number;
  /** Bolt pattern pitch — square. NEMA 17 = 31mm, NEMA 23 = 47.14mm, NEMA 14 = 26mm. */
  boltPitch: number;
  /** Pilot boss outer diameter (raised ring around the shaft on the front face). */
  pilotDia: number;
  /** Metric mount screw size for the bolt pattern. */
  mountScrew: MetricSize;
}

export const NEMA17: NemaMotorSpec = {
  body: 42,
  height: 40,
  shaft: 5,
  shaftLength: 24,
  boltPitch: 31,
  pilotDia: 22,
  mountScrew: "M3",
};

export const NEMA23: NemaMotorSpec = {
  body: 56.4,
  height: 56,
  shaft: 6.35,     // 1/4" imperial is common on NEMA 23; 8mm variants exist
  shaftLength: 21,
  boltPitch: 47.14,
  pilotDia: 38.1,
  mountScrew: "M4",
};

export const NEMA14: NemaMotorSpec = {
  body: 35,
  height: 28,
  shaft: 5,
  shaftLength: 20,
  boltPitch: 26,
  pilotDia: 22,
  mountScrew: "M3",
};

/**
 * Standard sports-ball dimensions (diameters only — weights and surface
 * properties are out of scope for CAD). Used by `cradles.cradle` and any
 * mechanism that needs to size a pocket or guide to a specific ball.
 *
 * Sources:
 *   - Tennis:   ITF "Rules of Tennis" — 6.54–6.86 cm, using 67 mm midpoint.
 *   - Ping pong: ITTF 40+ plastic ball (official since 2015).
 *   - Golf:     R&A / USGA — minimum 42.67 mm (1.68 in).
 *   - Baseball: MLB — 73 mm (2.86–2.94 in diameter).
 *   - Soccer:   FIFA size 5 — 68–70 cm circumference → ~216 mm diameter.
 */
export interface SportsBallSpec {
  /** Nominal diameter (mm). */
  diameter: number;
  /** Human-readable name (including the governing body). */
  name: string;
}

export const SPORTS_BALLS: Record<string, SportsBallSpec> = {
  tennis:   { diameter: 67,    name: "Tennis ball (ITF)" },
  pingpong: { diameter: 40,    name: "Table tennis ball" },
  golf:     { diameter: 42.67, name: "Golf ball (R&A/USGA)" },
  baseball: { diameter: 73,    name: "Baseball (MLB)" },
  soccer:   { diameter: 216,   name: "Soccer ball (FIFA size 5)" },
};

/** Flexible / jaw shaft coupler. Two bores, one per end. */
export interface FlexibleCouplerSpec {
  od: number;
  length: number;
  motorBore: number;
  leadscrewBore: number;
  /** How deep the motor-side bore extends (default half the length). */
  motorBoreDepth: number;
}

export const FLEXIBLE_COUPLER_5_8: FlexibleCouplerSpec = {
  od: 20,
  length: 25,
  motorBore: 5,
  leadscrewBore: 8,
  motorBoreDepth: 12.5,
};

export const FLEXIBLE_COUPLER_6_8: FlexibleCouplerSpec = {
  od: 25,
  length: 30,
  motorBore: 6.35,   // 1/4"
  leadscrewBore: 8,
  motorBoreDepth: 15,
};

/** ISO 261 metric thread pitch table (coarse pitch, mm). */
export const METRIC_COARSE_PITCH: Record<MetricSize, number> = {
  "M2":   0.4,
  "M2.5": 0.45,
  "M3":   0.5,
  "M4":   0.7,
  "M5":   0.8,
  "M6":   1.0,
  "M8":   1.25,
  "M10":  1.5,
  "M12":  1.75,
};

/** ISO 261 metric thread pitch table (fine pitch, mm). */
export const METRIC_FINE_PITCH: Record<MetricSize, number> = {
  "M2":   0.25,
  "M2.5": 0.35,
  "M3":   0.35,
  "M4":   0.5,
  "M5":   0.5,
  "M6":   0.75,
  "M8":   1.0,
  "M10":  1.25,
  "M12":  1.5,
};

/** Trapezoidal leadscrew spec (ISO 2901). `majorDia` is nominal diameter. */
export interface TrapezoidalLeadscrewSpec {
  majorDia: number;
  pitch: number;
  /** Number of thread starts. Most hobby leadscrews are 1 (single-start);
   *  common "high-speed" 8mm leadscrews are 4-start (TR8x8 = TR8x2 pitch × 4 starts). */
  starts: number;
  /** Effective lead per rotation (pitch × starts). */
  lead: number;
}

export const TRAPEZOIDAL_LEADSCREW: Record<string, TrapezoidalLeadscrewSpec> = {
  "TR8x2":   { majorDia: 8,  pitch: 2, starts: 1, lead: 2 },
  "TR8x8":   { majorDia: 8,  pitch: 2, starts: 4, lead: 8 },   // 4-start, popular on 3D printers
  "TR10x2":  { majorDia: 10, pitch: 2, starts: 1, lead: 2 },
  "TR12x2":  { majorDia: 12, pitch: 2, starts: 1, lead: 2 },
  "TR12x4":  { majorDia: 12, pitch: 2, starts: 2, lead: 4 },
};

/**
 * Throw if `size` isn't a key in `table`. Use at every `TABLE[size]` lookup
 * site before the lookup so an unknown metric size (e.g. "M10" when the table
 * only went to M8, or a plain typo like "m3") produces a readable error
 * listing the supported sizes instead of silently returning `undefined` and
 * propagating as NaN into OCCT.
 */
export function assertSupportedSize(
  size: unknown,
  table: Record<string, unknown>,
  tableName: string,
): asserts size is MetricSize {
  if (typeof size !== "string" || !(size in table)) {
    const supported = Object.keys(table).join(", ");
    throw new TypeError(
      `Unknown metric size '${String(size)}' for ${tableName}. Supported: ${supported}.`,
    );
  }
}

/**
 * Throw if `value` isn't a finite positive number. Use at stdlib boundaries
 * where an opaque OCCT "pointer exception" is the alternative — e.g. the
 * numeric path of `holes.through(d)` where a user typo propagates as NaN.
 * The error always names the caller (`fnName`) and the offending value so
 * the agent can self-correct without re-running.
 */
export function assertPositiveFinite(
  fnName: string,
  paramName: string,
  value: unknown
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `${fnName}: ${paramName} must be a finite positive number, got ${String(value)} (${typeof value}).`
    );
  }
}

/**
 * Simple did-you-mean suggestion: returns the single closest key by
 * case-insensitive substring overlap + edit distance (bounded). Conservative
 * — returns undefined when no candidate is clearly best. The goal isn't
 * best-in-class fuzzy matching, it's catching typos like `pilotDiameter` →
 * `pilotDia`.
 */
function didYouMean(target: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const t = target.toLowerCase();
  let best: { key: string; score: number } | undefined;
  for (const key of candidates) {
    const k = key.toLowerCase();
    let score = 0;
    if (k === t) score = 1000;
    else if (k.startsWith(t) || t.startsWith(k)) score = 100 - Math.abs(k.length - t.length);
    else if (k.includes(t) || t.includes(k)) score = 50 - Math.abs(k.length - t.length);
    else {
      // Shared-prefix length
      let shared = 0;
      const min = Math.min(k.length, t.length);
      for (let i = 0; i < min && k[i] === t[i]; i++) shared++;
      score = shared * 2;
    }
    if (!best || score > best.score) best = { key, score };
  }
  return best && best.score >= 6 ? best.key : undefined;
}

/**
 * Wrap an object with a Proxy that throws on unknown-key reads. Intended for
 * user-facing spec/table lookups where a typo (`standards.NEMA17.pilotDiameter`
 * vs `.pilotDia`) would otherwise silently return `undefined` and propagate
 * as NaN into downstream OCCT calls. Internal stdlib code imports the raw
 * tables directly from this module and bypasses the guard.
 *
 * The wrap is read-only on unknown keys — known keys, symbols, and common
 * host operations (toJSON, iteration) pass through. Writing new keys is
 * allowed so user code can decorate a spec if it really wants to.
 */
export function guardUnknownKeys<T extends object>(obj: T, label: string): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      // Allow inherited Object prototype reads (toString, hasOwnProperty, etc.)
      // so JSON.stringify and iteration still work without contortions.
      if (!(prop in target)) {
        if (prop in Object.prototype) return Reflect.get(target, prop, receiver);
        const keys = Object.keys(target);
        const suggestion = didYouMean(String(prop), keys);
        throw new TypeError(
          `Unknown key "${String(prop)}" on ${label}.` +
            (suggestion
              ? ` Did you mean "${suggestion}"?`
              : keys.length > 0
                ? ` Available: ${keys.join(", ")}.`
                : "")
        );
      }
      const value = Reflect.get(target, prop, receiver);
      // Recursively wrap plain-object descendants so deeper typos also throw.
      // Skip arrays, functions, and class instances (constructor !== Object).
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value.constructor === Object || value.constructor === undefined)
      ) {
        return guardUnknownKeys(value, `${label}.${String(prop)}`);
      }
      return value;
    },
  });
}

/**
 * Parse a screw designator like "M3x10" into size + length.
 * Accepts either "M3" (length = undefined) or "M3x10".
 */
export function parseScrewDesignator(
  spec: string
): { size: MetricSize; length?: number } {
  const match = spec.match(/^(M[\d.]+)(?:x(\d+(?:\.\d+)?))?$/);
  if (!match) throw new Error(`Invalid screw designator: "${spec}". Expected "M3" or "M3x10".`);
  const size = match[1] as MetricSize;
  if (!(size in SOCKET_HEAD)) {
    throw new Error(`Unsupported screw size: "${size}". Available: ${Object.keys(SOCKET_HEAD).join(", ")}`);
  }
  const length = match[2] ? parseFloat(match[2]) : undefined;
  return { size, length };
}
