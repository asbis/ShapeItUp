/**
 * A length of T-slot aluminum extrusion.
 *
 * Default: 200mm of 2020 profile. Change `size` to "3030" or "4040" for
 * heavier stock. Cross-section is the simplified quad-slot approximation —
 * see `extrusions.tSlotProfile` JSDoc for what it models and what it doesn't.
 */
import { extrusions } from "shapeitup";

export const params = {
  size: "2020",
  length: 200,
};

export default function main({ size, length }: typeof params) {
  return extrusions.tSlot(size, length);
}
